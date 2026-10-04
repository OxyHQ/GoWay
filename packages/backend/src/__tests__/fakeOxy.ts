/**
 * A stand-in for Oxy's account graph and files, over a real socket.
 *
 * GoWay asks Oxy one question — `GET /accounts/:id` with the caller's bearer —
 * and this answers it the way `oxy/packages/api/src/routes/accounts.ts` does:
 * `{ account: AccountNode }` with the caller's `callerMembership`, `404` for an
 * account that does not exist, `403` for one the caller cannot see. It is the
 * BOUNDARY being mocked, not GoWay's resolver: the real
 * `createAccountRoleResolver` and the real `@oxy.so/core` client run against
 * it, so a change in how either reads the answer is a failing test here.
 *
 * Files are answered the way `oxy/packages/api/src/routes/assets.ts` answers
 * them — `GET /assets/:id` to any signed-in caller with the owner and status,
 * `POST /assets/batch-access` with the visibility the caller may see,
 * `POST|DELETE /assets/:id/links` to any signed-in caller, the link SETTING
 * the visibility it is given — inside the `{ data }` envelope the real API
 * sends, so the real `@oxy.so/core` client unwraps exactly what it would.
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

/** One Oxy file, as the fake holds it. */
export interface FakeOxyFile {
  ownerUserId: string;
  status: 'active' | 'trash';
  mime: string;
  visibility: 'public' | 'private' | 'unlisted';
  metadata?: Record<string, unknown>;
}

/** One link, as Oxy records it. */
export interface FakeOxyLink {
  app: string;
  entityType: string;
  entityId: string;
  createdBy: string;
}

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
  /** Files by id. A file not here is `404`. */
  readonly files: Map<string, FakeOxyFile>;
  /** The links each file holds. */
  readonly links: Map<string, FakeOxyLink[]>;
  /** Every files request received: `METHOD /path`, and the person who made it. */
  readonly fileRequests: { request: string; person: string | undefined }[];
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
  app.use(express.json());
  const state = {
    memberships: new Map<string, FakeOxyRole | { role: FakeOxyRole; status: 'active' | 'invited' }>(),
    accounts: new Set<string>(),
    mode: 'ok' as FakeOxy['mode'],
    requests: [] as FakeOxy['requests'],
    files: new Map<string, FakeOxyFile>(),
    links: new Map<string, FakeOxyLink[]>(),
    fileRequests: [] as FakeOxy['fileRequests'],
  };

  /** The person a files request is from, or an answer that ends it. */
  function filesCaller(request: express.Request, response: express.Response): string | null {
    const person = personOf(request.header('authorization'));
    state.fileRequests.push({ request: `${request.method} ${request.path}`, person });
    if (state.mode === 'down') {
      response.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'down' });
      return null;
    }
    if (state.mode === 'unauthorized' || person === undefined) {
      response.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid session' });
      return null;
    }
    return person;
  }

  app.get('/assets/:id', (request, response) => {
    if (filesCaller(request, response) === null) return;
    const file = state.files.get(request.params.id);
    if (!file) {
      response.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
      return;
    }
    const now = new Date().toISOString();
    // No owner check and no visibility, exactly as the real route answers.
    response.json({
      data: {
        assetId: request.params.id,
        file: {
          id: request.params.id,
          sha256: 'a'.repeat(64),
          size: 1024,
          mime: file.mime,
          ext: 'jpg',
          ownerUserId: file.ownerUserId,
          status: file.status,
          usageCount: (state.links.get(request.params.id) ?? []).length,
          createdAt: now,
          updatedAt: now,
          links: state.links.get(request.params.id) ?? [],
          variants: [],
          metadata: file.metadata ?? {},
        },
      },
    });
  });

  app.post('/assets/batch-access', (request, response) => {
    const person = filesCaller(request, response);
    if (person === null) return;
    const requests = (request.body as { files?: { fileId: string }[] }).files ?? [];
    const results: Record<string, unknown> = {};
    for (const { fileId } of requests) {
      const file = state.files.get(fileId);
      if (!file) results[fileId] = { allowed: false, error: 'File not found' };
      else if (file.visibility !== 'public' && file.ownerUserId !== person) results[fileId] = { allowed: false, error: 'Access denied' };
      else results[fileId] = { allowed: true, url: `https://cloud.example/${fileId}`, visibility: file.visibility, mime: file.mime };
    }
    response.json({ data: { results } });
  });

  app.post('/assets/:id/links', (request, response) => {
    const person = filesCaller(request, response);
    if (person === null) return;
    const file = state.files.get(request.params.id);
    if (!file) {
      response.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
      return;
    }
    const body = request.body as { app: string; entityType: string; entityId: string; visibility?: FakeOxyFile['visibility'] };
    // The real link SETS the visibility, and infers `private` for a non-avatar type.
    file.visibility = body.visibility ?? 'private';
    const links = state.links.get(request.params.id) ?? [];
    if (!links.some((link) => link.app === body.app && link.entityType === body.entityType && link.entityId === body.entityId)) {
      links.push({ app: body.app, entityType: body.entityType, entityId: body.entityId, createdBy: person });
    }
    state.links.set(request.params.id, links);
    response.json({ data: { assetId: request.params.id, file: { id: request.params.id, usageCount: links.length, links, status: file.status } } });
  });

  app.delete('/assets/:id/links', (request, response) => {
    if (filesCaller(request, response) === null) return;
    const body = request.body as { app: string; entityType: string; entityId: string };
    const links = (state.links.get(request.params.id) ?? []).filter(
      (link) => !(link.app === body.app && link.entityType === body.entityType && link.entityId === body.entityId),
    );
    state.links.set(request.params.id, links);
    response.json({ data: { file: { id: request.params.id, usageCount: links.length, links, status: 'active' } } });
  });

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
