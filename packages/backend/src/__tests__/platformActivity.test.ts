/**
 * Oxy ecosystem activity: GoWay publishes on ECS and nowhere else, with no flag.
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
  it('starts nothing where the process cannot attest a workload identity', () => {
    let created = 0;
    const deps: PlatformActivityDeps = {
      canAttest: () => false,
      create: (() => {
        created += 1;
        return fakeTraffic().traffic;
      }) as PlatformActivityDeps['create'],
    };

    expect(startPlatformActivity(() => true, deps)).toBeUndefined();
    expect(created).toBe(0);
  });

  it('publishes as `goway` with the readiness callback, and wraps fetch once, where it can attest', () => {
    const { traffic, installs } = fakeTraffic();
    const calls: Parameters<PlatformActivityDeps['create']>[0][] = [];
    const ready = () => true;
    const deps: PlatformActivityDeps = {
      canAttest: () => true,
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
    expect(installs()).toBe(1);
  });

  describe('with the real attestation check', () => {
    const variable = 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI';
    const original = process.env[variable];
    afterEach(() => {
      if (original === undefined) delete process.env[variable];
      else process.env[variable] = original;
    });

    it('is off without the ECS container credentials endpoint — no env flag turns it on', () => {
      delete process.env[variable];
      process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'true';
      try {
        expect(startPlatformActivity(() => true)).toBeUndefined();
      } finally {
        delete process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
      }
    });
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
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
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
