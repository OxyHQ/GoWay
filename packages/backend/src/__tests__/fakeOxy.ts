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
 * `POST /assets/batch-access` with the visibility the caller may see, and
 * `POST|DELETE /assets/service/references` (ADR 0043 D4) to an application's
 * SERVICE token only: the application is the token's, an add takes any active
 * public or unlisted file and never changes its visibility, a removal drops
 * only that application's references, and each item answers
 * `created|exists|removed|not_found` — inside the `{ data }` envelope the real
 * API sends, so the real `@oxy.so/core` client unwraps exactly what it would.
 * The session routes `POST|DELETE /assets/:id/links` are not served: GoWay
 * must not use them, and a call to one is a `404` a test sees.
 *
 * A token is an UNSIGNED JWT — the `@oxy.so/core` client attaches only a token
 * shaped like a JWT, so a bare string would never reach this server. A
 * session's `sub` is a person: who Oxy resolves membership for, exactly as a
 * session that switched into an organization still resolves as the human
 * operating it. A workload service token (which the real `OxyServer` mints through the
 * challenge/attestation exchange) names its application.
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

/** One reference, as Oxy records it (`file_references`). */
export interface FakeOxyLink {
  /** The application id. */
  app: string;
  entityType: string;
  entityId: string;
  /** The person who made it; `null` for an application's service token. */
  createdBy: string | null;
  /** A counter, not a time: what a reconciliation compares against its start. */
  sequence?: number;
}

/** The application the fake's service credential belongs to. */
export const FAKE_SERVICE_APPLICATION_ID = 'app-goway';
/** Temporary role credential seam; no customer API key authenticates this workload. */
export const fakeWorkloadCredentials = async () => ({
  AccessKeyId: 'ASIA_GOWAY_FIXTURE',
  SecretAccessKey: 'fixture-secret',
  Token: 'fixture-session',
});

export interface FakeOxy {
  readonly url: string;
  /** `memberships.set('<person>\u0000<account>', role)` — or `role` with a status. */
  readonly memberships: Map<
    string,
    FakeOxyRole | { role: FakeOxyRole; status: 'active' | 'invited' }
  >;
  /** Accounts that exist. An account not here is `404`. */
  readonly accounts: Set<string>;
  /** `ok` answers; `down` answers 503 to everything; `unauthorized` answers 401. */
  mode: 'ok' | 'down' | 'unauthorized';
  /**
   * Whether GoWay's registered workload is active. `false` answers reference
   * routes `403`, including a request with an otherwise unexpired token.
   */
  workloadActive: boolean;
  /** `down` answers the reference routes alone 503; everything else still answers. */
  referencesMode: 'ok' | 'down';
  /** Every reconciliation step received, in order. */
  readonly reconcileRequests: {
    request: 'begin' | 'put' | 'commit';
    entityType: string;
    items?: number;
    dryRun?: boolean;
  }[];
  /** Every `GET /accounts/:id` received, with the bearer it carried. */
  readonly requests: { accountId: string; authorization: string | undefined }[];
  /** Files by id. A file not here is `404`. */
  readonly files: Map<string, FakeOxyFile>;
  /** The references each file holds. */
  readonly links: Map<string, FakeOxyLink[]>;
  /**
   * Every files request received: `METHOD /path`, and the person — or, for a
   * service token, `service:<applicationId>` — who made it.
   */
  readonly fileRequests: { request: string; person: string | undefined }[];
  close(): Promise<void>;
}

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** The bearer a test session for `person` carries. */
export function tokenFor(person: string): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: person, exp: 4_102_444_800 })}.unsigned`;
}

/** The service token the fake mints for `appId`: bounded, like Oxy's. */
function serviceTokenFor(appId: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ type: 'service', authority: 'first_party', appId, iat, exp: iat + 3600 })}.unsigned`;
}

function claimsOf(authorization: string | undefined): Record<string, unknown> | undefined {
  const payload = /^Bearer [^.]+\.([^.]+)\.unsigned$/.exec(authorization ?? '')?.[1];
  if (payload === undefined) return undefined;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The person a session bearer was minted for, or `undefined` for anything else. */
function personOf(authorization: string | undefined): string | undefined {
  const claims = claimsOf(authorization);
  return claims?.type !== 'service' && typeof claims?.sub === 'string' ? claims.sub : undefined;
}

/** The application a service bearer was minted for, or `undefined` for anything else. */
function applicationOf(authorization: string | undefined): string | undefined {
  const claims = claimsOf(authorization);
  return claims?.type === 'service' && typeof claims.appId === 'string' ? claims.appId : undefined;
}

export function membershipKey(person: string, accountId: string): string {
  return `${person}\u0000${accountId}`;
}

export async function startFakeOxy(): Promise<FakeOxy> {
  const app = express();
  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  app.use(express.json());
  const state = {
    memberships: new Map<
      string,
      FakeOxyRole | { role: FakeOxyRole; status: 'active' | 'invited' }
    >(),
    accounts: new Set<string>(),
    mode: 'ok' as FakeOxy['mode'],
    workloadActive: true,
    reconcileRequests: [] as FakeOxy['reconcileRequests'],
    referencesMode: 'ok' as FakeOxy['referencesMode'],
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
      else if (file.visibility !== 'public' && file.ownerUserId !== person)
        results[fileId] = { allowed: false, error: 'Access denied' };
      else
        results[fileId] = {
          allowed: true,
          url: `https://cloud.example/${fileId}`,
          visibility: file.visibility,
          mime: file.mime,
        };
    }
    response.json({ data: { results } });
  });

  app.post('/auth/service-token/workload/challenge', (_request, response) => {
    response.json({ data: { nonce: 'goway-fixture-challenge' } });
  });
  app.post('/auth/service-token/workload', (request, response) => {
    if (state.mode === 'down') {
      response.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'down' });
      return;
    }
    const body = request.body;
    if (
      body.provider !== 'aws-iam' ||
      body.protocolVersion !== 2 ||
      body.nonce !== 'goway-fixture-challenge' ||
      body.attestation?.headers?.['x-oxy-attestation-nonce'] !== body.nonce ||
      !body.attestation?.headers?.authorization?.includes('ASIA_GOWAY_FIXTURE')
    ) {
      response.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid workload proof' });
      return;
    }
    response.json({
      data: {
        token: serviceTokenFor(FAKE_SERVICE_APPLICATION_ID),
        expiresIn: 3600,
        appName: 'GoWay',
      },
    });
  });

  type ReferenceItem = { fileId: string; entityType: string; entityId: string };

  /** The application a reference call is from, or an answer that ends it. */
  function referencesCaller(request: express.Request, response: express.Response): string | null {
    const application = applicationOf(request.header('authorization'));
    state.fileRequests.push({
      request: `${request.method} ${request.path}`,
      person:
        application === undefined
          ? personOf(request.header('authorization'))
          : `service:${application}`,
    });
    if (state.mode === 'down' || state.referencesMode === 'down') {
      response.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'down' });
      return null;
    }
    if (application === undefined) {
      // A session is not a service token: the real route answers 401.
      response.status(401).json({ error: 'UNAUTHORIZED', message: 'Service token required' });
      return null;
    }
    if (!state.workloadActive) {
      response.status(403).json({ error: 'FORBIDDEN', message: 'Workload binding revoked' });
      return null;
    }
    return application;
  }

  const sameReference = (link: FakeOxyLink, application: string, item: ReferenceItem) =>
    link.app === application &&
    link.entityType === item.entityType &&
    link.entityId === item.entityId;

  app.post('/assets/service/references', (request, response) => {
    const application = referencesCaller(request, response);
    if (application === null) return;
    const { references } = request.body as { references: ReferenceItem[] };
    const results = references.map((item) => {
      const file = state.files.get(item.fileId);
      // Any owner's active public or unlisted file; never a visibility change.
      if (file?.status !== 'active' || file.visibility === 'private') {
        return { ...item, result: 'not_found' };
      }
      const links = state.links.get(item.fileId) ?? [];
      if (links.some((link) => sameReference(link, application, item))) {
        return { ...item, result: 'exists' };
      }
      links.push({
        app: application,
        entityType: item.entityType,
        entityId: item.entityId,
        createdBy: null,
        sequence: nextSequence(),
      });
      state.links.set(item.fileId, links);
      return { ...item, result: 'created' };
    });
    response.json({ data: { results } });
  });

  app.delete('/assets/service/references', (request, response) => {
    const application = referencesCaller(request, response);
    if (application === null) return;
    const { references } = request.body as { references: ReferenceItem[] };
    const results = references.map((item) => {
      const links = state.links.get(item.fileId) ?? [];
      const kept = links.filter((link) => !sameReference(link, application, item));
      state.links.set(item.fileId, kept);
      return { ...item, result: kept.length < links.length ? 'removed' : 'not_found' };
    });
    response.json({ data: { results } });
  });

  /**
   * Reconciliation (ADR 0043 D6): begin → PUT pages → commit, one open session
   * per (application, entity type). The commit adds every listed pair the
   * application may reference and lacks, and removes every reference of that
   * type the application holds, made before the begin, that the inventory
   * does not list; `dryRun` counts and changes nothing.
   */
  const reconciliations = new Map<
    string,
    {
      application: string;
      entityType: string;
      startedAt: number;
      items: { fileId: string; entityId: string }[];
    }
  >();

  app.post('/assets/service/references/reconcile', (request, response) => {
    const application = referencesCaller(request, response);
    if (application === null) return;
    const { entityType } = request.body as { entityType: string };
    if (
      [...reconciliations.values()].some(
        (open) => open.application === application && open.entityType === entityType,
      )
    ) {
      response.status(409).json({ error: 'RECONCILIATION_IN_PROGRESS', message: 'busy' });
      return;
    }
    const sessionId = `reconcile-${String(nextSequence())}`;
    reconciliations.set(sessionId, {
      application,
      entityType,
      startedAt: nextSequence(),
      items: [],
    });
    state.reconcileRequests.push({ request: 'begin', entityType });
    response.json({ data: { sessionId } });
  });

  app.put('/assets/service/references/reconcile/:sessionId', (request, response) => {
    const application = referencesCaller(request, response);
    if (application === null) return;
    const open = reconciliations.get(request.params.sessionId);
    if (open?.application !== application) {
      response.status(404).json({ error: 'NOT_FOUND', message: 'No such reconciliation' });
      return;
    }
    const { items } = request.body as { items: { fileId: string; entityId: string }[] };
    open.items.push(...items);
    state.reconcileRequests.push({
      request: 'put',
      entityType: open.entityType,
      items: items.length,
    });
    response.json({ data: { received: open.items.length } });
  });

  app.post('/assets/service/references/reconcile/:sessionId/commit', (request, response) => {
    const application = referencesCaller(request, response);
    if (application === null) return;
    const sessionId = request.params.sessionId;
    const open = reconciliations.get(sessionId);
    if (open?.application !== application) {
      response.status(404).json({ error: 'NOT_FOUND', message: 'No such reconciliation' });
      return;
    }
    reconciliations.delete(sessionId);
    const dryRun = (request.body as { dryRun?: boolean }).dryRun === true;
    const key = (fileId: string, entityId: string) => `${fileId}\u0000${entityId}`;
    const listed = new Set(open.items.map((item) => key(item.fileId, item.entityId)));
    let added = 0;
    let unchanged = 0;
    let refused = 0;
    let removed = 0;
    for (const item of new Map(
      open.items.map((entry) => [key(entry.fileId, entry.entityId), entry]),
    ).values()) {
      const reference = {
        fileId: item.fileId,
        entityType: open.entityType,
        entityId: item.entityId,
      };
      const links = state.links.get(item.fileId) ?? [];
      if (links.some((link) => sameReference(link, application, reference))) {
        unchanged += 1;
        continue;
      }
      const file = state.files.get(item.fileId);
      if (file?.status !== 'active' || file.visibility === 'private') {
        refused += 1;
        continue;
      }
      added += 1;
      if (!dryRun) {
        links.push({
          app: application,
          entityType: open.entityType,
          entityId: item.entityId,
          createdBy: null,
          sequence: nextSequence(),
        });
        state.links.set(item.fileId, links);
      }
    }
    for (const [fileId, links] of state.links) {
      const stale = (link: FakeOxyLink) =>
        link.app === application &&
        link.entityType === open.entityType &&
        (link.sequence ?? 0) < open.startedAt &&
        !listed.has(key(fileId, link.entityId));
      removed += links.filter(stale).length;
      if (!dryRun)
        state.links.set(
          fileId,
          links.filter((link) => !stale(link)),
        );
    }
    state.reconcileRequests.push({ request: 'commit', entityType: open.entityType, dryRun });
    response.json({
      data: { sessionId, entityType: open.entityType, dryRun, added, removed, unchanged, refused },
    });
  });

  app.delete('/assets/service/references/reconcile/:sessionId', (request, response) => {
    if (referencesCaller(request, response) === null) return;
    reconciliations.delete(request.params.sessionId);
    response.json({ data: { released: true } });
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
        account: {
          accountId,
          kind: 'personal',
          parentAccountId: null,
          account: { id: accountId },
          relationship: 'self',
          callerMembership: null,
        },
      });
      return;
    }
    const held = state.memberships.get(membershipKey(person, accountId));
    if (held === undefined) {
      response
        .status(403)
        .json({ error: 'FORBIDDEN', message: 'You do not have access to this account' });
      return;
    }
    const { role, status } =
      typeof held === 'string' ? { role: held, status: 'active' as const } : held;
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
