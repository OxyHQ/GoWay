import importlib.util
import json
from pathlib import Path
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

    def simulate(self, exit_code=0, desired=1, restore=False, execution_role=None, task_definition=None, template_family='goway'):
        calls = []
        snapshot_count = 0
        def snapshot(*_args):
            nonlocal snapshot_count
            snapshot_count += 1
            return {'status': 'ACTIVE', 'desiredCount': desired if snapshot_count == 1 else max(1, desired),
                    'runningCount': desired if snapshot_count == 1 else max(1, desired), 'taskDefinition': 'arn:aws:ecs:region:account:task-definition/goway:1',
                    'networkConfiguration': {'awsvpcConfiguration': {'subnets': ['private'], 'securityGroups': ['existing']}},
                    'deployments': [{'id': 'new-rollout', 'taskDefinition': 'new', 'rolloutState': 'COMPLETED', 'runningCount': max(1, desired)}]}
        def call(*args):
            calls.append(args)
            action = args[1]
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
                self.assertIn('--phase=pre', args[args.index('--overrides') + 1])
                return {'tasks': [{'taskArn': 'migration'}]}
            if action == 'describe-tasks':
                return {'tasks': [{'lastStatus': 'STOPPED', 'containers': [{'name': 'goway', 'exitCode': exit_code}]}]}
            if action == 'update-service':
                self.assertIn('describe-tasks', [c[1] for c in calls])
                return {'service': {'deployments': [{'status': 'PRIMARY', 'id': 'new-rollout'}]}}
            raise AssertionError(action)
        try:
            module.deploy('cluster', 'goway', 'repo@sha256:abc', 'goway', restore, call, snapshot, execution_role=execution_role, task_definition=task_definition)
        except RuntimeError:
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

    def test_paused_service_requires_explicit_restore(self):
        calls, succeeded = self.simulate(desired=0)
        self.assertFalse(succeeded)
        self.assertEqual(calls, [])
        calls, succeeded = self.simulate(desired=0, restore=True)
        self.assertTrue(succeeded)
        update = next(c for c in calls if c[1] == 'update-service')
        self.assertEqual(update[update.index('--desired-count') + 1], '1')


if __name__ == '__main__':
    unittest.main()
