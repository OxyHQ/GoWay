/**
 * Oxy ecosystem activity: GoWay publishes through a temporary registered role, with no permission flag.
 *
 * The factory is injected rather than `mock.module`d: bun runs every test file
 * in one process, so replacing `@oxy.so/core/server` here would replace it for
 * the auth middleware every other suite builds on.
 *
 * `./testEnv` FIRST, because `../app` parses config at module load.
 */

import './testEnv';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { createApp } from '../app';
import {
  startPlatformActivity,
  type PlatformActivity,
  type PlatformActivityDeps,
} from '../platformActivity';
import { defined } from './defined';

function fakeTraffic(): { traffic: PlatformActivity; installs: () => number } {
  let installs = 0;
  const traffic = {
    installFetch: () => {
      installs += 1;
    },
  } as unknown as PlatformActivity;
  return { traffic, installs: () => installs };
}

describe('startPlatformActivity', () => {
  it('publishes as `goway` with the readiness callback, and wraps fetch once, where it can attest', () => {
    const { traffic, installs } = fakeTraffic();
    const calls: Parameters<PlatformActivityDeps['create']>[0][] = [];
    const ready = () => true;
    const deps: PlatformActivityDeps = {
      region: 'us-west-2',
      create: ((options) => {
        calls.push(options);
        return traffic;
      }) as PlatformActivityDeps['create'],
    };

    expect(startPlatformActivity(ready, deps)).toBe(traffic);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe('goway');
    expect(calls[0]?.ready).toBe(ready);
    // No credential: GoWay holds no key pair, so the SDK attests the task role.
    expect(calls[0]?.credential).toBeUndefined();
    expect(typeof calls[0]?.workloadCredentials).toBe('function');
    expect(installs()).toBe(1);
  });

  it('uses the temporary provider even when no ECS endpoint is present', () => {
    const calls: Parameters<PlatformActivityDeps['create']>[0][] = [];
    startPlatformActivity(() => true, {
      region: 'us-west-2',
      create: ((options) => {
        calls.push(options);
        return fakeTraffic().traffic;
      }) as PlatformActivityDeps['create'],
    });
    expect(typeof calls[0]?.workloadCredentials).toBe('function');
  });
});

describe('createApp with an activity observer', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const current = server;
    server = undefined;
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  });

  async function listen(activity?: RequestHandler): Promise<string> {
    server = createApp({ activity }).listen(0);
    await new Promise<void>((resolve) => defined(server).once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  it('observes requests the terminal handlers answer, because it is mounted first', async () => {
    const seen: string[] = [];
    const origin = await listen((request, _response, next) => {
      seen.push(`${request.method} ${request.path}`);
      next();
    });

    const response = await fetch(`${origin}/api/v1/no-such-route`);
    expect(response.status).toBe(404);
    expect(seen).toEqual(['GET /api/v1/no-such-route']);
  });

  it('serves normally without one', async () => {
    const origin = await listen();
    expect((await fetch(`${origin}/api/v1/no-such-route`)).status).toBe(404);
  });
});
