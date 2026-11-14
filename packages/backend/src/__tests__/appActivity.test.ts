/**
 * `createApp` mounts the ecosystem activity observer first, and builds without one.
 *
 * `./testEnv` FIRST, because `../app` parses config at module load.
 */

import './testEnv';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { createApp } from '../app';
import { defined } from './defined';

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
