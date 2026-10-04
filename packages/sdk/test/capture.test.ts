import { describe, expect, it } from 'vitest';
import { createGoWayClient, type CaptureAssetInput } from '../src/index';
import { parseCaptureAsset, parseCaptureSession, parseCaptureTicket } from '../src/parse';
import { fakeFetch } from './helpers';

const time = '2026-10-01T00:00:00.000Z';
const evidence = { origin: 'user_placed', witness: 'client', coordinate: { latitude: 41, longitude: 2 } };
const asset = {
  id: 'asset-1', sessionId: 'session-1', mediaKind: 'photo', source: 'library', state: 'expected',
  privacy: { state: 'pending' }, reconstructionEligible: false, anchor: evidence, locationEvidence: [evidence],
  media: { contentHashAlgorithm: 'sha256', contentHash: 'a'.repeat(64), byteSize: 42,
    contentType: 'image/jpeg', deduplicated: false,
    lifecycle: { retentionClass: 'raw_photo', retentionReason: 'awaiting_overlap', storedAt: time, expiresAt: time, extensionCount: 0 } },
  createdAt: time, updatedAt: time,
};
const upload = { assetId: 'asset-1', method: 'PUT', url: 'https://storage.invalid/object?signature=example',
  headers: { 'x-amz-checksum-sha256': 'checksum', 'if-none-match': '*' }, byteSize: 42, contentType: 'image/jpeg', expiresAt: time };

describe('contribution client boundary', () => {
  it('keeps registration idempotency and never sends bytes or credentials to the storage URL', async () => {
    const { fetch, calls } = fakeFetch(201, { asset, upload });
    const client = createGoWayClient({ fetch, getAccessToken: async () => 'session-token' });
    const input: CaptureAssetInput = { idempotencyKey: 'a9318d9b-b89d-416c-855a-56b42d3b586e', mediaKind: 'photo',
      source: 'library', contentHash: 'a'.repeat(64), byteSize: 42, contentType: 'image/jpeg',
      location: [{ origin: 'user_placed', coordinate: { latitude: 41, longitude: 2 } }] };
    const ticket = await client.captures.register('session 1', input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/captures/sessions/session%201/assets');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual(input);
    expect(ticket.upload?.headers['if-none-match']).toBe('*');
    expect(calls[0]?.url).not.toContain('storage.invalid');
  });
  it('uses authenticated DELETE for a withdrawal and preserves privacy state', async () => {
    const { fetch, calls } = fakeFetch(200, { ...asset, state: 'deleted', privacy: { state: 'blocked', completedAt: time } });
    const result = await createGoWayClient({ fetch, getAccessToken: () => 'session-token' }).captures.remove('asset 1');
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/captures/assets/asset%201');
    expect(result.state).toBe('deleted');
    expect(result.reconstructionEligible).toBe(false);
  });
  it('strips private fields and rejects unknown privacy decisions and invalid upload targets', () => {
    const parsed = parseCaptureAsset({ ...asset, oxyUserId: 'private', objectKey: 'private',
      media: { ...asset.media, objectKey: 'private' }, anchor: { ...evidence, privateNote: 'private' } });
    expect(JSON.stringify(parsed)).not.toContain('private');
    expect(() => parseCaptureAsset({ ...asset, privacy: { state: 'trusted' } })).toThrow();
    expect(() => parseCaptureTicket({ asset, upload: { ...upload, url: 'javascript:bad()' } })).toThrow();
    expect(parseCaptureTicket({ asset }).upload).toBeUndefined();
  });
  it('reads a session licence credit and rejects a blank one', () => {
    const session = { id: 's', source: 'library', consentVersion: 'v', startedAt: time, assetCount: 0, createdAt: time, updatedAt: time };
    expect(parseCaptureSession({ ...session, attribution: 'Imagery © Example, CC BY-SA 4.0' }).attribution).toBe('Imagery © Example, CC BY-SA 4.0');
    expect(parseCaptureSession(session).attribution).toBeUndefined();
    expect(() => parseCaptureSession({ ...session, attribution: '  ' })).toThrow();
  });
});
