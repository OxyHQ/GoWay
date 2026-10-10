import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  DEFAULT_CAPTURE_LIST_LIMIT,
  GoWayResponseError,
  GoWayValidationError,
  type CaptureAssetInput,
} from '../src/index';
import { page } from './fixtures';
import { fakeFetch, queryOf, rejection } from './helpers';

const time = '2026-10-01T00:00:00.000Z';
const evidence = {
  origin: 'user_placed',
  witness: 'client',
  coordinate: { latitude: 41, longitude: 2 },
};
const asset = {
  id: 'asset-1',
  sessionId: 'session-1',
  mediaKind: 'photo',
  source: 'library',
  state: 'expected',
  privacy: { state: 'pending' },
  reconstructionEligible: false,
  anchor: evidence,
  locationEvidence: [evidence],
  media: {
    contentHashAlgorithm: 'sha256',
    contentHash: 'a'.repeat(64),
    byteSize: 42,
    contentType: 'image/jpeg',
    deduplicated: false,
    lifecycle: {
      retentionClass: 'raw_photo',
      retentionReason: 'awaiting_overlap',
      storedAt: time,
      expiresAt: time,
      extensionCount: 0,
    },
  },
  createdAt: time,
  updatedAt: time,
};
const session = {
  id: 's',
  source: 'library',
  consentVersion: 'v',
  startedAt: time,
  assetCount: 0,
  createdAt: time,
  updatedAt: time,
};
const upload = {
  assetId: 'asset-1',
  method: 'PUT',
  url: 'https://storage.invalid/object?signature=example',
  headers: { 'x-amz-checksum-sha256': 'checksum', 'if-none-match': '*' },
  byteSize: 42,
  contentType: 'image/jpeg',
  expiresAt: time,
};

function client(status: number, body: unknown) {
  const { fetch, calls } = fakeFetch(status, body);
  return {
    captures: createGoWayClient({ fetch, getAccessToken: () => 'session-token' }).captures,
    calls,
  };
}

describe('contribution client boundary', () => {
  it('keeps registration idempotency and never sends bytes or credentials to the storage URL', async () => {
    const { captures, calls } = client(201, { asset, upload });
    const input: CaptureAssetInput = {
      idempotencyKey: 'a9318d9b-b89d-416c-855a-56b42d3b586e',
      mediaKind: 'photo',
      source: 'library',
      contentHash: 'a'.repeat(64),
      byteSize: 42,
      contentType: 'image/jpeg',
      location: [{ origin: 'user_placed', coordinate: { latitude: 41, longitude: 2 } }],
    };
    const ticket = await captures.register('session 1', input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/captures/sessions/session%201/assets');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual(input);
    expect(ticket.upload?.headers['if-none-match']).toBe('*');
    expect(calls[0]?.url).not.toContain('storage.invalid');
  });

  it('refuses a registration the contract refuses, before sending it', async () => {
    const { captures, calls } = client(201, { asset, upload });
    const both = {
      origin: 'user_placed',
      coordinate: { latitude: 41, longitude: 2 },
      exifGps: { latitude: { degrees: 41, ref: 'N' }, longitude: { degrees: 2, ref: 'E' } },
    };
    const input = {
      mediaKind: 'photo',
      source: 'library',
      contentHash: 'not-a-digest',
      byteSize: 42,
      contentType: 'image/jpeg',
      location: [both],
    } as CaptureAssetInput;
    const error = await rejection(captures.register('s', input));
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(error.message).toContain('input.contentHash');
    expect(calls).toHaveLength(0);
  });

  it('uses authenticated DELETE for a withdrawal and resolves with nothing on 204', async () => {
    const { captures, calls } = client(204, '');
    await expect(captures.remove('asset 1')).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.init.headers.Authorization).toBe('Bearer session-token');
    expect(calls[0]?.url).toContain('/captures/assets/asset%201');
  });

  it('pages sessions and assets with the contract default limit', async () => {
    const sessions = client(200, page([session], 'older_1'));
    const first = await sessions.captures.sessions();
    expect(queryOf(sessions.calls[0]!.url)).toBe(`limit=${DEFAULT_CAPTURE_LIST_LIMIT}`);
    expect(first.nextCursor).toBe('older_1');
    await sessions.captures.sessions({ cursor: 'older_1', limit: 10 });
    expect(queryOf(sessions.calls[1]!.url)).toBe('cursor=older_1&limit=10');

    const assets = client(200, page([asset]));
    const listed = await assets.captures.assets('session-1', { limit: 100 });
    expect(assets.calls[0]?.url).toContain('/captures/sessions/session-1/assets?limit=100');
    expect(listed.items[0]?.id).toBe('asset-1');
    await expect(assets.captures.assets('session-1', { limit: 101 })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
  });

  it('strips private fields from an asset', async () => {
    const { captures } = client(200, {
      ...asset,
      oxyUserId: 'private',
      objectKey: 'private',
      media: { ...asset.media, objectKey: 'private' },
      anchor: { ...evidence, privateNote: 'private' },
    });
    expect(JSON.stringify(await captures.asset('asset-1'))).not.toContain('private');
  });

  it('rejects unknown privacy decisions and invalid upload targets', async () => {
    const unknownPrivacy = client(200, { ...asset, privacy: { state: 'trusted' } });
    expect(await rejection(unknownPrivacy.captures.asset('asset-1'))).toBeInstanceOf(
      GoWayResponseError,
    );
    const deduplicated = client(201, { asset });
    const input: CaptureAssetInput = {
      mediaKind: 'photo',
      source: 'library',
      contentHash: 'a'.repeat(64),
      byteSize: 42,
      contentType: 'image/jpeg',
      location: [{ origin: 'user_placed', coordinate: { latitude: 41, longitude: 2 } }],
    };
    expect((await deduplicated.captures.register('s', input)).upload).toBeUndefined();
    const insecure = client(201, { asset, upload: { ...upload, url: 'javascript:bad()' } });
    expect(await rejection(insecure.captures.register('s', input))).toBeInstanceOf(
      GoWayResponseError,
    );
  });

  it('reads the declared projection, and a server that sends none as perspective', async () => {
    expect((await client(200, asset).captures.asset('asset-1')).projection).toBe('perspective');
    expect(
      (await client(200, { ...asset, projection: 'equirectangular' }).captures.asset('asset-1'))
        .projection,
    ).toBe('equirectangular');
    expect(
      await rejection(client(200, { ...asset, projection: 'fisheye' }).captures.asset('asset-1')),
    ).toBeInstanceOf(GoWayResponseError);
    const { captures, calls } = client(201, { asset: { ...asset, projection: 'equirectangular' } });
    const input: CaptureAssetInput = {
      mediaKind: 'photo',
      projection: 'equirectangular',
      source: 'library',
      contentHash: 'a'.repeat(64),
      byteSize: 42,
      contentType: 'image/jpeg',
      location: [{ origin: 'user_placed', coordinate: { latitude: 41, longitude: 2 } }],
    };
    await captures.register('s', input);
    expect(JSON.parse(calls[0]!.init.body!).projection).toBe('equirectangular');
    await expect(
      captures.register('s', { ...input, projection: 'fisheye' } as unknown as CaptureAssetInput),
    ).rejects.toBeInstanceOf(GoWayValidationError);
  });

  it('reads the 360° limits only when the deployment publishes them', async () => {
    const policy = {
      enabled: true,
      consentVersion: 'v',
      contentHashAlgorithm: 'sha256',
      photo: { contentTypes: ['image/jpeg'], maxByteSize: 1 },
      video: { contentTypes: ['video/mp4'], maxByteSize: 2, maxDurationSeconds: 3 },
      retentionDays: {
        raw_photo: 90,
        raw_video: 30,
        extracted_keyframe: 180,
        privacy_safe_proxy: 180,
        thumbnail: 180,
      },
    };
    expect((await client(200, policy).captures.policy()).equirectangular).toBeUndefined();
    const equirectangular = {
      photo: { maxByteSize: 4, maxWidthPixels: 12000 },
      video: { maxByteSize: 5, maxDurationSeconds: 6, maxWidthPixels: 7680 },
    };
    expect(
      (await client(200, { ...policy, equirectangular }).captures.policy()).equirectangular,
    ).toEqual(equirectangular);
    expect(
      await rejection(client(200, { ...policy, equirectangular: { photo: {} } }).captures.policy()),
    ).toBeInstanceOf(GoWayResponseError);
  });

  it('reads a session licence credit and rejects a blank one', async () => {
    const credited = client(200, { ...session, attribution: 'Imagery © Example, CC BY-SA 4.0' });
    expect((await credited.captures.session('s')).attribution).toBe(
      'Imagery © Example, CC BY-SA 4.0',
    );
    const plain = client(200, session);
    expect((await plain.captures.session('s')).attribution).toBeUndefined();
    const blank = client(200, { ...session, attribution: '' });
    expect(await rejection(blank.captures.session('s'))).toBeInstanceOf(GoWayResponseError);
  });
});
