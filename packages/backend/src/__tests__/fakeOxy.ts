/**
 * A stand-in for Oxy's account graph, over a real socket.
 *
 * GoWay asks Oxy one question — `GET /accounts/:id` with the caller's bearer —
 * and this answers it the way `oxy/packages/api/src/routes/accounts.ts` does:
 * `{ account: AccountNode }` with the caller's `callerMembership`, `404` for an
 * account that does not exist, `403` for one the caller cannot see. It is the
 * BOUNDARY being mocked, not GoWay's resolver: the real
 * `createAccountRoleResolver` and the real `@oxy.so/core` client run against
 * it, so a change in how either reads the answer is a failing test here.
 *
 * A token is an UNSIGNED JWT whose `sub` is a person — the `@oxy.so/core`
 * client attaches only a token shaped like a JWT, so a bare string would never
 * reach this server. The person is who Oxy resolves membership for, exactly as
 * a session that switched into an organization still resolves as the human
 * operating it.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeOxyRole = 'owner' | 'admin' | 'editor' | 'developer' | 'billing' | 'viewer';

export interface FakeOxy {
  readonly url: string;
  /** `memberships.set('<person>\u0000<account>', role)` — or `role` with a status. */
  readonly memberships: Map<string, FakeOxyRole | { role: FakeOxyRole; status: 'active' | 'invited' }>;
  /** Accounts that exist. An account not here is `404`. */
  readonly accounts: Set<string>;
  /** `ok` answers; `down` answers 503 to everything; `unauthorized` answers 401. */
  mode: 'ok' | 'down' | 'unauthorized';
  /** Every `GET /accounts/:id` received, with the bearer it carried. */
  readonly requests: { accountId: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The bearer a test session for `person` carries. */
export function tokenFor(person: string): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: person, exp: 4_102_444_800 })}.unsigned`;
}

/** The person a bearer was minted for, or `undefined` for anything else. */
function personOf(authorization: string | undefined): string | undefined {
  const payload = /^Bearer [^.]+\.([^.]+)\.unsigned$/.exec(authorization ?? '')?.[1];
  if (payload === undefined) return undefined;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown };
  return typeof claims.sub === 'string' ? claims.sub : undefined;
}

export function membershipKey(person: string, accountId: string): string {
  return `${person}\u0000${accountId}`;
}

export async function startFakeOxy(): Promise<FakeOxy> {
  const app = express();
  const state = {
    memberships: new Map<string, FakeOxyRole | { role: FakeOxyRole; status: 'active' | 'invited' }>(),
    accounts: new Set<string>(),
    mode: 'ok' as FakeOxy['mode'],
    requests: [] as FakeOxy['requests'],
  };

  app.get('/accounts/:id', (request, response) => {
    const accountId = request.params.id;
    const authorization = request.header('authorization');
    state.requests.push({ accountId, authorization });
    if (state.mode === 'down') {
      response.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'down' });
      return;
    }
    const person = personOf(authorization);
    if (state.mode === 'unauthorized' || person === undefined) {
      response.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid session' });
      return;
    }
    if (!state.accounts.has(accountId)) {
      response.status(404).json({ error: 'NOT_FOUND', message: 'Account not found' });
      return;
    }
    const now = new Date().toISOString();
    if (person === accountId) {
      response.json({
        account: { accountId, kind: 'personal', parentAccountId: null, account: { id: accountId }, relationship: 'self', callerMembership: null },
      });
      return;
    }
    const held = state.memberships.get(membershipKey(person, accountId));
    if (held === undefined) {
      response.status(403).json({ error: 'FORBIDDEN', message: 'You do not have access to this account' });
      return;
    }
    const { role, status } = typeof held === 'string' ? { role: held, status: 'active' as const } : held;
    response.json({
      account: {
        accountId,
        kind: 'organization',
        parentAccountId: null,
        account: { id: accountId },
        relationship: role === 'owner' ? 'owner' : 'member',
        callerMembership: {
          _id: `m-${person}-${accountId}`,
          accountId,
          memberUserId: person,
          role,
          permissions: [],
          inherit: true,
          status,
          source: 'direct',
          createdAt: now,
          updatedAt: now,
        },
      },
    });
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return Object.assign(state, {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
