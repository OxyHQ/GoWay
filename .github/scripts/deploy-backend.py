#!/usr/bin/env python3
"""Migrate an immutable ECS image before serving it; verify the exact rollout; then run post migrations."""
import argparse
import json
import re
import subprocess
import sys
import time

TASK_FIELDS = (
    'family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
    'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory',
    'pidMode', 'ipcMode', 'proxyConfiguration', 'inferenceAccelerators',
    'ephemeralStorage', 'runtimePlatform',
)


def aws(*args):
    result = subprocess.run(['aws', *args, '--output', 'json'], capture_output=True, text=True)
    if result.returncode:
        # Do not print task definitions, environments, credentials or SQL logs.
        code = re.search(r'An error occurred \(([A-Za-z0-9]+)\)', result.stderr)
        reason = code.group(1) if code else f'exit {result.returncode}'
        raise RuntimeError(f'AWS {args[0]} {args[1]} failed ({reason})')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def definition_for_image(source, container, image):
    result = {key: source[key] for key in TASK_FIELDS if key in source}
    result = json.loads(json.dumps(result))
    matches = [c for c in result['containerDefinitions'] if c['name'] == container]
    if len(matches) != 1:
        raise ValueError('Expected exactly one backend container')
    if '@sha256:' not in image:
        raise ValueError('Deployment requires an immutable image digest')
    matches[0]['image'] = image
    return result


def service_snapshot(cluster, service):
    response = aws('ecs', 'describe-services', '--cluster', cluster, '--services', service)
    if response.get('failures') or len(response.get('services', [])) != 1:
        raise RuntimeError('Backend service is unavailable; no rollout was performed')
    return response['services'][0]


def migrate(cluster, service, registered, database, phase, launch, before, call, outcome):
    override = {'containerOverrides': [{'name': service, 'command': [
        'bun', 'packages/backend/dist/src/db/migrate.js', f'--target-database={database}', f'--phase={phase}',
    ]}]}
    response = call('ecs', 'run-task', '--cluster', cluster, '--task-definition', registered,
                    *launch, '--network-configuration', json.dumps(before['networkConfiguration']),
                    '--overrides', json.dumps(override), '--tags', 'key=App,value=goway', '--count', '1')
    if response.get('failures') or len(response.get('tasks', [])) != 1:
        raise RuntimeError(f'Could not start the {phase} migration task; {outcome}')
    task = response['tasks'][0]['taskArn']
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        task_state = call('ecs', 'describe-tasks', '--cluster', cluster, '--tasks', task)
        if task_state.get('failures') or len(task_state.get('tasks', [])) != 1:
            raise RuntimeError(f'The {phase} migration task disappeared; {outcome}')
        state = task_state['tasks'][0]
        if state['lastStatus'] == 'STOPPED':
            containers = state.get('containers', [])
            completed = [c for c in containers if c['name'] == service]
            if len(completed) != 1 or completed[0].get('exitCode') != 0 or any(c.get('exitCode', 0) != 0 for c in containers):
                raise RuntimeError(f'The {phase} migration task failed; {outcome}. Inspect its restricted task logs')
            return
        time.sleep(5)
    call('ecs', 'stop-task', '--cluster', cluster, '--task', task, '--reason', 'Migration deployment timeout')
    raise RuntimeError(f'The {phase} migration timed out; {outcome}')


def deploy(cluster, service, image, database, restore_capacity=False, call=aws, snapshot=service_snapshot, execution_role=None, task_definition=None):
    before = snapshot(cluster, service)
    desired = before['desiredCount']
    print(json.dumps({'stage': 'inspect', 'desired': desired, 'running': before['runningCount']}), flush=True)
    if before['status'] != 'ACTIVE':
        raise RuntimeError('Backend service is not active')
    if desired == 0 and not restore_capacity:
        raise RuntimeError('Backend capacity is zero; explicitly request restore-capacity to bring it online')
    source = call('ecs', 'describe-task-definition', '--task-definition', task_definition or before['taskDefinition'])['taskDefinition']
    if task_definition and source['family'] != before['taskDefinition'].split('/')[-1].split(':')[0]:
        raise ValueError('Runtime template must belong to the existing service family')
    definition = definition_for_image(source, service, image)
    if execution_role:
        definition['executionRoleArn'] = execution_role
    registered = call('ecs', 'register-task-definition', '--cli-input-json', json.dumps(definition))['taskDefinition']['taskDefinitionArn']
    launch = ['--capacity-provider-strategy', json.dumps(before['capacityProviderStrategy'])] if before.get('capacityProviderStrategy') else ['--launch-type', before.get('launchType', 'FARGATE')]
    migrate(cluster, service, registered, database, 'pre', launch, before, call, 'service was not changed')
    print(json.dumps({'stage': 'migrated'}), flush=True)
    response = call('ecs', 'update-service', '--cluster', cluster, '--service', service,
                    '--task-definition', registered, '--desired-count', str(max(1, desired)), '--force-new-deployment')
    primary = [d for d in response['service']['deployments'] if d['status'] == 'PRIMARY']
    if len(primary) != 1:
        raise RuntimeError('New deployment ID was not returned')
    deployment_id = primary[0]['id']
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        current = snapshot(cluster, service)
        deployments = [d for d in current['deployments'] if d['id'] == deployment_id]
        if not deployments or deployments[0].get('rolloutState') == 'FAILED':
            raise RuntimeError('The requested rollout failed or was superseded')
        deployed = deployments[0]
        if deployed.get('rolloutState') == 'COMPLETED' and current['desiredCount'] > 0 and current['runningCount'] == current['desiredCount'] and deployed.get('runningCount') == current['desiredCount'] and deployed['taskDefinition'] == registered:
            print(json.dumps({'stage': 'serving', 'running': current['runningCount']}), flush=True)
            break
        time.sleep(5)
    else:
        raise RuntimeError('The requested image did not become healthy before the deadline')
    # Post migrations take something away from the previous image, so they run only once the new one alone is serving.
    # If one fails the new revision stays: it never needed the post phase, which is safe to apply late and to retry,
    # whereas rolling back would return the old image to a schema the post phase may already have partly narrowed.
    migrate(cluster, service, registered, database, 'post', launch, before, call, 'the new revision is still serving; re-run the post phase')
    print(json.dumps({'stage': 'post-migrated'}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cluster', required=True)
    parser.add_argument('--service', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--restore-capacity', action='store_true')
    parser.add_argument('--execution-role')
    parser.add_argument('--task-definition')
    args = parser.parse_args()
    deploy(args.cluster, args.service, args.image, args.database, args.restore_capacity, execution_role=args.execution_role, task_definition=args.task_definition)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError) as error:
        print(f'::error::{error}', file=sys.stderr)
        sys.exit(1)
