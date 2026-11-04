/**
 * An HTTP harness for the organization, history and moderation suites.
 *
 * The session is faked the way `@oxy.so/core/server`'s middleware leaves it on
 * a request — `userId`, `accessToken` and the actor chain `getOxyActor` reads —
 * from two headers:
 *
 *  - `x-test-user`  the session's EFFECTIVE account (an organization after a switch);
 *  - `x-test-actor` the person operating it, defaulting to the user.
 *
 * The bearer is `fakeOxy`'s token for the PERSON, so the real role resolver
 * asking the fake Oxy gets the person's memberships, as the real Oxy answers.
 */

import express, { type RequestHandler, type Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '../http/apiError';
import { errorHandler, unknownRouteHandler } from '../http/errorHandler';
import { tokenFor } from './fakeOxy';

function resolveSession(request: express.Request): boolean {
  const user = request.header('x-test-user');
  if (!user) return false;
  const actor = request.header('x-test-actor') ?? user;
  request.userId = user;
  request.accessToken = tokenFor(actor);
  request.oxyActor = {
    schemaVersion: 1,
    effectiveAccountId: user,
    actorAccountId: actor,
    delegated: actor !== user,
  } as NonNullable<express.Request['oxyActor']>;
  return true;
}

export const fakeOptionalAuth: RequestHandler = (request, _response, next) => {
  resolveSession(request);
  next();
};

export const fakeRequireAuth: RequestHandler = (request, _response, next) => {
  if (!resolveSession(request)) {
    next(new ApiError('unauthorized', 'This request requires an Oxy session.'));
    return;
  }
  next();
};

/** Headers for a session of `user`, operated by `actor` (the same person unless they switched). */
export function session(user: string, actor: string = user): Record<string, string> {
  return { 'x-test-user': user, 'x-test-actor': actor };
}

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

export interface Fetched<T> {
  status: number;
  body: T;
}

export interface TestApi {
  /** `method path` under `/api/v1`, as `headers`, with an optional JSON body. */
  call<T>(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: unknown,
  ): Promise<Fetched<T>>;
  close(): Promise<void>;
}

/** Serve `routers` under `/api/v1` with the real error envelope, on an OS-chosen port. */
export async function serve(...routers: Router[]): Promise<TestApi> {
  const app = express();
  app.use(express.json());
  for (const router of routers) app.use('/api/v1', router);
  app.use(unknownRouteHandler);
  app.use(errorHandler);

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    async call<T>(
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: unknown,
    ) {
      const response = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (response.status === 204 ? undefined : await response.json()) as T,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
