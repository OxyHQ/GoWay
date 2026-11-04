/**
 * Account access and application permissions against Oxy's HTTP boundary.
 *
 * The real `OxyServer` runs against `fakeOxy`, so what is under test is
 * GoWay's reading of what Oxy actually answers: access, no access, a refused
 * session, an outage — and that only an answer is ever remembered, never a
 * refusal or an outage.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  accessErrorStatus,
  appPermissionErrorStatus,
  OxyAccessError,
  OxyAppPermissionError,
} from '@oxy.so/core/server';
import type { Request } from 'express';
import {
  fakeOxyServer,
  membershipKey,
  startFakeOxy,
  tokenFor,
  type FakeOxy,
} from '../../__tests__/fakeOxy';
import { isApiError } from '../../http/apiError';
import {
  ACCOUNT_PERMISSIONS,
  createAccountAccessResolver,
  createOrganizationAuthority,
  type OxyCaller,
} from '../accountAccess';
import { CAPTURE_PILOT_PERMISSION, createContributionGate } from '../appPermissions';

let oxy: FakeOxy;

beforeAll(async () => {
  oxy = await startFakeOxy();
  oxy.accounts.add('org-cafe');
  oxy.accounts.add('person-ana');
  oxy.memberships.set(membershipKey('person-ana', 'org-cafe'), 'editor');
  oxy.memberships.set(membershipKey('person-bo', 'org-cafe'), 'viewer');
  oxy.memberships.set(membershipKey('person-cy', 'org-cafe'), { role: 'admin', status: 'invited' });
  oxy.memberships.set(membershipKey('person-di', 'org-cafe'), 'admin');
  oxy.appPermissions.set('person-pilot', [CAPTURE_PILOT_PERMISSION]);
});

afterAll(async () => {
  await oxy.close();
});

beforeEach(() => {
  oxy.mode = 'ok';
  oxy.requests.length = 0;
  oxy.roleReads.length = 0;
});

/** A request the auth middleware resolved for `person`, operating `account`. */
function requestOf(person: string, method = 'POST', account = person): Request {
  return {
    method,
    userId: account,
    sessionId: `session-${person}`,
    accessToken: tokenFor(person),
  } as Request;
}

function callerOf(person: string, method = 'POST', account = person): OxyCaller {
  return {
    oxyAccountId: account,
    operatedByOxyUserId: person,
    request: requestOf(person, method, account),
  };
}

/** The HTTP status GoWay answers a rejected read with. */
async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OxyAccessError) return accessErrorStatus(error);
    if (error instanceof OxyAppPermissionError) return appPermissionErrorStatus(error, 403);
    if (isApiError(error)) return error.status;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('accessIn', () => {
  it('reads the caller EFFECTIVE permissions, asked with the caller own bearer', async () => {
    const accounts = createAccountAccessResolver(fakeOxyServer(oxy));
    const ana = await accounts.accessIn(callerOf('person-ana'), 'org-cafe');
    expect(ana?.has(ACCOUNT_PERMISSIONS.actAs)).toBe(true);
    expect(ana?.has(ACCOUNT_PERMISSIONS.update)).toBe(false);
    const bo = await accounts.accessIn(callerOf('person-bo'), 'org-cafe');
    expect(bo?.has(ACCOUNT_PERMISSIONS.actAs)).toBe(false);
    expect(oxy.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${tokenFor('person-ana')}`,
      `Bearer ${tokenFor('person-bo')}`,
    ]);
  });

  it('treats a 403 and a 404 from Oxy as no access, never as an outage', async () => {
    const accounts = createAccountAccessResolver(fakeOxyServer(oxy));
    expect(await accounts.accessIn(callerOf('person-stranger'), 'org-cafe')).toBeNull();
    expect(await accounts.accessIn(callerOf('person-ana'), 'org-that-does-not-exist')).toBeNull();
    expect(await accounts.accessIn(callerOf('person-cy'), 'org-cafe')).toBeNull();
  });

  it('fails CLOSED with 503 when Oxy cannot answer, and with 401 for a refused session', async () => {
    const accounts = createAccountAccessResolver(fakeOxyServer(oxy));
    oxy.mode = 'down';
    expect(await statusOf(accounts.accessIn(callerOf('person-ana'), 'org-cafe'))).toBe(503);
    oxy.mode = 'unauthorized';
    expect(await statusOf(accounts.accessIn(callerOf('person-ana'), 'org-cafe'))).toBe(401);
  });

  it('fails closed when Oxy is not there at all', async () => {
    // A port that was just listening and is now closed, so the connection
    // itself is refused. Not a well-known closed port: under WSL a connection
    // to one hangs instead of being refused.
    const gone = await startFakeOxy();
    await gone.close();
    const accounts = createAccountAccessResolver(fakeOxyServer(gone));
    expect(await statusOf(accounts.accessIn(callerOf('person-ana'), 'org-cafe'))).toBe(503);
  });

  it('reuses an answer for a read, asks afresh for a write, and never remembers an outage', async () => {
    const accounts = createAccountAccessResolver(
      fakeOxyServer(oxy, { appPermissionsCacheTtlMs: 30_000 }),
    );
    await accounts.accessIn(callerOf('person-di', 'GET'), 'org-cafe');
    await accounts.accessIn(callerOf('person-di', 'GET'), 'org-cafe');
    expect(oxy.requests).toHaveLength(1);
    await accounts.accessIn(callerOf('person-di', 'PATCH'), 'org-cafe');
    expect(oxy.requests).toHaveLength(2);

    oxy.mode = 'down';
    expect(await statusOf(accounts.accessIn(callerOf('person-ana', 'GET'), 'org-cafe'))).toBe(503);
    oxy.mode = 'ok';
    const after = await accounts.accessIn(callerOf('person-ana', 'GET'), 'org-cafe');
    expect(after?.has(ACCOUNT_PERMISSIONS.actAs)).toBe(true);
  });
});

describe('organization authority', () => {
  it('admits a person who may act for the organization, refuses the rest', async () => {
    const authorize = createOrganizationAuthority(createAccountAccessResolver(fakeOxyServer(oxy)));
    await authorize(callerOf('person-ana'), 'org-cafe');
    expect(await statusOf(authorize(callerOf('person-bo'), 'org-cafe'))).toBe(403);
    // Their own personal account is not an organization.
    expect(await statusOf(authorize(callerOf('person-ana'), 'person-ana'))).toBe(403);
    oxy.mode = 'down';
    expect(await statusOf(authorize(callerOf('person-ana'), 'org-cafe'))).toBe(503);
  });
});

describe('the capture pilot gate', () => {
  it('admits a holder of capture.pilot, and nobody else', async () => {
    const mayContribute = createContributionGate(fakeOxyServer(oxy));
    expect(await mayContribute(requestOf('person-pilot'))).toBe(true);
    expect(await mayContribute(requestOf('person-ana'))).toBe(false);
    // Signed out: nobody to ask about, and no request to Oxy.
    expect(await mayContribute({ method: 'GET' } as Request)).toBe(false);
    expect(oxy.roleReads).toEqual(['person-pilot', 'person-ana']);
  });

  it('rejects with 503 when Oxy cannot say, and asks again next time', async () => {
    const mayContribute = createContributionGate(
      fakeOxyServer(oxy, { appPermissionsCacheTtlMs: 30_000 }),
    );
    oxy.mode = 'down';
    expect(await statusOf(mayContribute(requestOf('person-pilot', 'GET')))).toBe(503);
    oxy.mode = 'ok';
    expect(await mayContribute(requestOf('person-pilot', 'GET'))).toBe(true);
  });
});
