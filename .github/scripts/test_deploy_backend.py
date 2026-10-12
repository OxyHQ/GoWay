import importlib.util
import json
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('deploy_backend', Path(__file__).with_name('deploy-backend.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeployTests(unittest.TestCase):
    def test_definition_preserves_roles_and_settings_but_pins_only_backend(self):
        original = {'family': 'goway', 'taskRoleArn': 'role', 'revision': 9,
                    'containerDefinitions': [{'name': 'goway', 'image': 'old', 'secrets': [{'name': 'DATABASE_URL', 'valueFrom': 'ssm-path'}]}, {'name': 'sidecar', 'image': 'sidecar'}]}
        result = module.definition_for_image(original, 'goway', 'repo@sha256:abc')
        self.assertEqual(result['taskRoleArn'], 'role')
        self.assertNotIn('revision', result)
        self.assertEqual(result['containerDefinitions'][0]['image'], 'repo@sha256:abc')
        self.assertEqual(result['containerDefinitions'][1]['image'], 'sidecar')
        self.assertEqual(original['containerDefinitions'][0]['image'], 'old')
        with self.assertRaises(ValueError):
            module.definition_for_image(original, 'goway', 'repo:latest')

    def simulate(self, exit_code=0, desired=1, restore=False, execution_role=None, task_definition=None, template_family='goway', rollout_state='COMPLETED', post_exit_code=0):
        calls = []
        self.events = []
        snapshot_count = 0
        def snapshot(*_args):
            nonlocal snapshot_count
            snapshot_count += 1
            self.events.append(('snapshot', snapshot_count))
            return {'status': 'ACTIVE', 'desiredCount': desired if snapshot_count == 1 else max(1, desired),
                    'runningCount': desired if snapshot_count == 1 else max(1, desired), 'taskDefinition': 'arn:aws:ecs:region:account:task-definition/goway:1',
                    'networkConfiguration': {'awsvpcConfiguration': {'subnets': ['private'], 'securityGroups': ['existing']}},
                    'deployments': [{'id': 'new-rollout', 'taskDefinition': 'new', 'rolloutState': rollout_state, 'runningCount': max(1, desired)}]}
        def call(*args):
            calls.append(args)
            action = args[1]
            self.events.append(('call', action))
            if action == 'describe-task-definition':
                self.assertEqual(args[-1], task_definition or 'arn:aws:ecs:region:account:task-definition/goway:1')
                return {'taskDefinition': {'family': template_family, 'containerDefinitions': [{'name': 'goway', 'image': 'old'}]}}
            if action == 'register-task-definition':
                definition = json.loads(args[args.index('--cli-input-json') + 1])
                if execution_role:
                    self.assertEqual(definition['executionRoleArn'], execution_role)
                return {'taskDefinition': {'taskDefinitionArn': 'new'}}
            if action == 'run-task':
                self.assertIn('--network-configuration', args)
                self.assertEqual(args[args.index('--task-definition') + 1], 'new')
                command = json.loads(args[args.index('--overrides') + 1])['containerOverrides'][0]['command']
                self.assertIn('--target-database=goway', command)
                phase = next(a for a in command if a.startswith('--phase=')).split('=', 1)[1]
                self.assertEqual(phase, 'post' if 'update-service' in [c[1] for c in calls] else 'pre')
                return {'tasks': [{'taskArn': f'migration-{phase}'}]}
            if action == 'describe-tasks':
                code = post_exit_code if args[args.index('--tasks') + 1] == 'migration-post' else exit_code
                return {'tasks': [{'lastStatus': 'STOPPED', 'containers': [{'name': 'goway', 'exitCode': code}]}]}
            if action == 'update-service':
                self.assertIn('describe-tasks', [c[1] for c in calls])
                return {'service': {'deployments': [{'status': 'PRIMARY', 'id': 'new-rollout'}]}}
            raise AssertionError(action)
        try:
            module.deploy('cluster', 'goway', 'repo@sha256:abc', 'goway', restore, call, snapshot, execution_role=execution_role, task_definition=task_definition)
        except RuntimeError as error:
            self.error = str(error)
            return calls, False
        return calls, True

    def test_migration_failure_never_changes_service(self):
        calls, succeeded = self.simulate(exit_code=1)
        self.assertFalse(succeeded)
        self.assertNotIn('update-service', [c[1] for c in calls])

    def test_healthy_rollout_requires_successful_migration(self):
        calls, succeeded = self.simulate()
        self.assertTrue(succeeded)
        self.assertIn('update-service', [c[1] for c in calls])

    def test_dedicated_execution_identity_is_used_for_migration_and_service(self):
        calls, succeeded = self.simulate(execution_role='arn:aws:iam::123456789012:role/goway-execution')
        self.assertTrue(succeeded)
        run = next(c for c in calls if c[1] == 'run-task')
        self.assertEqual(run[run.index('--tags') + 1], 'key=App,value=goway')

    def test_reviewed_template_is_adopted_only_within_the_existing_family(self):
        _, succeeded = self.simulate(task_definition='arn:aws:ecs:region:account:task-definition/goway:2')
        self.assertTrue(succeeded)
        with self.assertRaisesRegex(ValueError, 'existing service family'):
            self.simulate(task_definition='other-app:1', template_family='other-app')

    def phases(self, calls):
        return [next(a for a in json.loads(c[c.index('--overrides') + 1])['containerOverrides'][0]['command'] if a.startswith('--phase='))
                for c in calls if c[1] == 'run-task']

    def test_post_migration_runs_only_after_the_new_revision_is_stable(self):
        calls, succeeded = self.simulate()
        self.assertTrue(succeeded)
        self.assertEqual(self.phases(calls), ['--phase=pre', '--phase=post'])
        post = next(c for c in calls if c[1] == 'run-task' and '--phase=post' in c[c.index('--overrides') + 1])
        self.assertIn('--target-database=goway', post[post.index('--overrides') + 1])
        # The stable snapshot (the second) is the last thing seen before the post task starts.
        stable = self.events.index(('snapshot', 2))
        self.assertLess(self.events.index(('call', 'update-service')), stable)
        self.assertEqual([e for e in self.events[stable:] if e[0] == 'call'][0], ('call', 'run-task'))

    def test_failed_rollout_never_runs_post_migration(self):
        calls, succeeded = self.simulate(rollout_state='FAILED')
        self.assertFalse(succeeded)
        self.assertIn('update-service', [c[1] for c in calls])
        self.assertEqual(self.phases(calls), ['--phase=pre'])

    def test_failed_post_migration_fails_deploy_without_rolling_back(self):
        calls, succeeded = self.simulate(post_exit_code=1)
        self.assertFalse(succeeded)
        self.assertEqual(self.phases(calls), ['--phase=pre', '--phase=post'])
        self.assertEqual([c[1] for c in calls].count('update-service'), 1)
        self.assertEqual(calls[-1][1], 'describe-tasks')
        self.assertIn('post migration task failed; the new revision is still serving', self.error)

    def test_paused_service_requires_explicit_restore(self):
        calls, succeeded = self.simulate(desired=0)
        self.assertFalse(succeeded)
        self.assertEqual(calls, [])
        calls, succeeded = self.simulate(desired=0, restore=True)
        self.assertTrue(succeeded)
        update = next(c for c in calls if c[1] == 'update-service')
        self.assertEqual(update[update.index('--desired-count') + 1], '1')

WORKFLOWS = Path(__file__).resolve().parent.parent / 'workflows'
# The only repo secrets a workflow may read: what CI itself spends. Runtime
# secrets live only in SSM /oxy/goway/* (oxy-infra runbook 46); until
# 2026-10-10 the deploy copied repo secrets into SSM on every run.
CI_ONLY_SECRETS = {'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'NPM_TOKEN', 'ADD_TO_PROJECT_TOKEN'}
SSM_WRITE = re.compile(r'\bssm\s+(put-parameter|delete-parameters?|label-parameter-version)\b', re.I)
SECRET_READ = re.compile(r'\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)')


def workflow_violations(name, text):
    """Comment lines are skipped so the rule can be explained where it applies."""
    code = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
    errors = []
    if SSM_WRITE.search(code):
        errors.append(f'{name}: writes SSM')
    errors += [f'{name}: reads repo secret {s}' for s in SECRET_READ.findall(code) if s not in CI_ONLY_SECRETS]
    return errors


class WorkflowSecretTests(unittest.TestCase):
    def test_no_workflow_writes_ssm_or_reads_a_runtime_secret(self):
        files = sorted(WORKFLOWS.glob('*.y*ml'))
        self.assertGreater(len(files), 3)  # vacuity floor
        errors = [e for f in files for e in workflow_violations(f.name, f.read_text())]
        self.assertEqual(errors, [])

    def test_the_rule_can_fail(self):
        self.assertTrue(workflow_violations('w', 'env:\n  DATABASE_URL: ${{ secrets.DATABASE_URL }}\n'))
        self.assertTrue(workflow_violations('w', 'run: aws ssm put-parameter --name /oxy/goway/X --overwrite\n'))
        self.assertEqual(workflow_violations('w', '# set with `aws ssm put-parameter`\nenv:\n  T: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n'), [])


if __name__ == '__main__':
    unittest.main()
