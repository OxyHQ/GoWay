#!/usr/bin/env python3
"""Migrate an immutable ECS image before serving it; verify the exact rollout."""
import argparse
import json
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
        raise RuntimeError(f'AWS {args[0]} {args[1]} failed (exit {result.returncode})')
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


def deploy(cluster, service, image, database, restore_capacity=False, call=aws, snapshot=service_snapshot):
    before = snapshot(cluster, service)
    desired = before['desiredCount']
    print(json.dumps({'stage': 'inspect', 'desired': desired, 'running': before['runningCount']}), flush=True)
    if before['status'] != 'ACTIVE':
        raise RuntimeError('Backend service is not active')
    if desired == 0 and not restore_capacity:
        raise RuntimeError('Backend capacity is zero; explicitly request restore-capacity to bring it online')
    source = call('ecs', 'describe-task-definition', '--task-definition', before['taskDefinition'])['taskDefinition']
    definition = definition_for_image(source, service, image)
    registered = call('ecs', 'register-task-definition', '--cli-input-json', json.dumps(definition))['taskDefinition']['taskDefinitionArn']
    override = {'containerOverrides': [{'name': service, 'command': [
        'bun', 'packages/backend/dist/src/db/migrate.js', f'--target-database={database}', '--phase=pre',
    ]}]}
    launch = ['--capacity-provider-strategy', json.dumps(before['capacityProviderStrategy'])] if before.get('capacityProviderStrategy') else ['--launch-type', before.get('launchType', 'FARGATE')]
    response = call('ecs', 'run-task', '--cluster', cluster, '--task-definition', registered,
                    *launch, '--network-configuration', json.dumps(before['networkConfiguration']),
                    '--overrides', json.dumps(override), '--count', '1')
    if response.get('failures') or len(response.get('tasks', [])) != 1:
        raise RuntimeError('Could not start the migration task; service was not changed')
    task = response['tasks'][0]['taskArn']
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        task_state = call('ecs', 'describe-tasks', '--cluster', cluster, '--tasks', task)
        if task_state.get('failures') or len(task_state.get('tasks', [])) != 1:
            raise RuntimeError('Migration task disappeared; service was not changed')
        state = task_state['tasks'][0]
        if state['lastStatus'] == 'STOPPED':
            containers = state.get('containers', [])
            completed = [c for c in containers if c['name'] == service]
            if len(completed) != 1 or completed[0].get('exitCode') != 0 or any(c.get('exitCode', 0) != 0 for c in containers):
                raise RuntimeError('Migration task failed; service was not changed. Inspect its restricted task logs')
            break
        time.sleep(5)
    else:
        call('ecs', 'stop-task', '--cluster', cluster, '--task', task, '--reason', 'Migration deployment timeout')
        raise RuntimeError('Migration timed out; service was not changed')
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
            return
        time.sleep(5)
    raise RuntimeError('The requested image did not become healthy before the deadline')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cluster', required=True)
    parser.add_argument('--service', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--restore-capacity', action='store_true')
    args = parser.parse_args()
    deploy(args.cluster, args.service, args.image, args.database, args.restore_capacity)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError) as error:
        print(f'::error::{error}', file=sys.stderr)
        sys.exit(1)
