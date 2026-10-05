/**
 * The account-role resolver against Oxy's HTTP boundary.
 *
 * The real `@oxy.so/core` client runs against `fakeOxy`, so what is under test
 * is GoWay's translation of what Oxy actually answers: a role, no role, a
 * refused session, an outage — and that the answer is cached per PERSON, never
 * per effective account.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { isApiError } from '../../http/apiError';
import { membershipKey, startFakeOxy, tokenFor, type FakeOxy } from '../../__tests__/fakeOxy';
import { createAccountRoleResolver, type OxyCaller } from '../accountRoles';

let oxy: FakeOxy;

beforeAll(async () => {
  oxy = await startFakeOxy();
  oxy.accounts.add('org-cafe');
  oxy.accounts.add('person-ana');
  oxy.memberships.set(membershipKey('person-ana', 'org-cafe'), 'editor');
  oxy.memberships.set(membershipKey('person-bo', 'org-cafe'), 'viewer');
  oxy.memberships.set(membershipKey('person-cy', 'org-cafe'), { role: 'admin', status: 'invited' });
});

afterAll(async () => {
  await oxy.close();
});

beforeEach(() => {
  oxy.mode = 'ok';
  oxy.requests.length = 0;
});

/** A personal session for `person`. */
function personal(person: string): OxyCaller {
  return { oxyAccountId: person, operatedByOxyUserId: person, accessToken: tokenFor(person) };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('roleIn', () => {
  it('reads the caller role from callerMembership, asked with the caller own bearer', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    expect(await roles.roleIn(personal('person-ana'), 'org-cafe')).toBe('editor');
    expect(await roles.roleIn(personal('person-bo'), 'org-cafe')).toBe('viewer');
    expect(oxy.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${tokenFor('person-ana')}`,
      `Bearer ${tokenFor('person-bo')}`,
    ]);
  });

  it('treats a 403 and a 404 from Oxy as no role, never as an outage', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    expect(await roles.roleIn(personal('person-stranger'), 'org-cafe')).toBeNull();
    expect(await roles.roleIn(personal('person-ana'), 'org-that-does-not-exist')).toBeNull();
  });

  it('gives the caller own personal account the owner role', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    expect(await roles.roleIn(personal('person-ana'), 'person-ana')).toBe('owner');
  });

  it('does not count a membership that is not active', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    expect(await roles.roleIn(personal('person-cy'), 'org-cafe')).toBeNull();
  });

  it('fails CLOSED with service_unavailable when Oxy cannot answer', async () => {
    oxy.mode = 'down';
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    expect(await refusal(roles.roleIn(personal('person-ana'), 'org-cafe'))).toBe('service_unavailable');
  });

  it('fails closed when Oxy is not there at all', async () => {
    // A port that was just listening and is now closed, so the connection
    // itself is refused. Not a well-known closed port: under WSL a connection
    // to one hangs instead of being refused.
    const gone = await startFakeOxy();
    await gone.close();
    const roles = createAccountRoleResolver({ oxyApiUrl: gone.url });
    expect(await refusal(roles.roleIn(personal('person-ana'), 'org-cafe'))).toBe('service_unavailable');
  });

  it('answers a session Oxy refuses with unauthorized', async () => {
    oxy.mode = 'unauthorized';
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    expect(await refusal(roles.roleIn(personal('person-ana'), 'org-cafe'))).toBe('unauthorized');
  });
});

describe('the cache', () => {
  it('reuses an answer for the same person and account until the TTL passes', async () => {
    let now = 1_000;
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url, ttlMs: 100, now: () => now });
    await roles.roleIn(personal('person-ana'), 'org-cafe');
    await roles.roleIn(personal('person-ana'), 'org-cafe');
    expect(oxy.requests).toHaveLength(1);

    now += 101;
    await roles.roleIn(personal('person-ana'), 'org-cafe');
    expect(oxy.requests).toHaveLength(2);
  });

  it('keys on the PERSON: two people switched into the same organization never share an answer', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    const asOrg = (person: string): OxyCaller => ({
      oxyAccountId: 'org-other',
      operatedByOxyUserId: person,
      accessToken: tokenFor(person),
    });
    expect(await roles.roleIn(asOrg('person-ana'), 'org-cafe')).toBe('editor');
    expect(await roles.roleIn(asOrg('person-bo'), 'org-cafe')).toBe('viewer');
    expect(oxy.requests).toHaveLength(2);
  });

  it('does not cache a session whose person Oxy did not report', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    const unknown: OxyCaller = { oxyAccountId: 'person-ana', operatedByOxyUserId: null, accessToken: tokenFor('person-ana') };
    await roles.roleIn(unknown, 'org-cafe');
    await roles.roleIn(unknown, 'org-cafe');
    expect(oxy.requests).toHaveLength(2);
  });

  it('never caches a failure', async () => {
    const roles = createAccountRoleResolver({ oxyApiUrl: oxy.url });
    oxy.mode = 'down';
    expect(await refusal(roles.roleIn(personal('person-ana'), 'org-cafe'))).toBe('service_unavailable');
    oxy.mode = 'ok';
    expect(await roles.roleIn(personal('person-ana'), 'org-cafe')).toBe('editor');
  });
});
