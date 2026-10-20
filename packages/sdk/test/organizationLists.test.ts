import { describe, expect, it } from 'vitest';
import { createGoWayClient, GoWayResponseError, GoWayValidationError } from '../src/index';
import { organizationListEntryInputSchema } from '@goway/contracts';
const list = {
  id: 'l1',
  oxyAccountId: 'org',
  title: 'List',
  description: '',
  revision: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const activity = {
  placeId: 'p1',
  activity: 'Collection',
  startsAt: '2030-01-01T09:00:00Z',
  endsAt: '2030-01-01T10:00:00Z',
};
describe('organization lists SDK', () => {
  it('validates reference-only activity input and exact instant ordering before transport', () => {
    const client = createGoWayClient({
      fetch: async () => {
        throw new Error('must not send');
      },
    });
    expect(() =>
      client.organizationLists.addEntry('l1', { ...activity, endsAt: activity.startsAt }),
    ).toThrow(GoWayValidationError);
    expect(
      organizationListEntryInputSchema.safeParse({
        ...activity,
        startsAt: '2030-01-01T09:00:00Z',
        endsAt: '2030-01-01T09:00:00.100Z',
      }).success,
    ).toBe(true);
    expect(
      organizationListEntryInputSchema.safeParse({ ...activity, name: 'copied place name' })
        .success,
    ).toBe(false);
  });
  it('uses current bearer, preserves input refs and parses responses', async () => {
    const requests: { url: string; body: unknown; auth: string | undefined }[] = [];
    let token = 'first';
    const client = createGoWayClient({
      getAccessToken: () => token,
      fetch: async (url, init) => {
        requests.push({
          url,
          body: init.body ? JSON.parse(init.body) : undefined,
          auth: init.headers.Authorization,
        });
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(list),
        };
      },
    });
    expect((await client.organizationLists.get('l1')).id).toBe('l1');
    token = 'second';
    await client.organizationLists.update('l1', { title: 'New title' });
    expect(requests.map((r) => r.auth)).toEqual(['Bearer first', 'Bearer second']);
    expect(requests[1]?.body).toEqual({ title: 'New title', description: '' });
  });
  it('iterates pages and refuses repeating cursors', async () => {
    let calls = 0;
    const client = createGoWayClient({
      fetch: async () => {
        calls++;
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ items: [list], nextCursor: 'repeat' }),
        };
      },
    });
    const consume = async () => {
      for await (const _item of client.organizationLists.iterate()) {
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(GoWayResponseError);
    expect(calls).toBe(2);
  });
});
