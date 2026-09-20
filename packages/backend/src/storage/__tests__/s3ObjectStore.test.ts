/**
 * The S3 adapter, without an AWS account.
 *
 * What is asserted is the part a wrong implementation still "works" without:
 * that the target is scoped to one key, one method and one deadline, that the
 * content type and length are COVERED by the signature rather than merely
 * suggested, and that changing any input changes the signature. A presigner
 * that signed nothing would still produce a URL a test could fetch.
 */

import { describe, expect, it } from 'bun:test';
import { createEnvironmentCredentialsProvider, createS3ObjectStore } from '../s3ObjectStore';

const FIXED_NOW = new Date('2026-09-20T11:45:30.000Z');

const credentials = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

function store(overrides: Parameters<typeof createS3ObjectStore>[0] | null = null) {
  return createS3ObjectStore(
    overrides ?? {
      bucket: 'goway-captures',
      region: 'eu-west-1',
      resolveCredentials: async () => credentials,
      now: () => FIXED_NOW,
    },
  );
}

describe('createUploadTarget', () => {
  it('scopes the target to one bucket, one key and one deadline', async () => {
    const target = await store().createUploadTarget({
      key: 'captures/2026/09/obj-1',
      contentType: 'image/jpeg',
      byteSize: 2048,
      ttlSeconds: 900,
    });
    const url = new URL(target.url);
    expect(url.host).toBe('goway-captures.s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/captures/2026/09/obj-1');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260920T114530Z');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAEXAMPLE/20260920/eu-west-1/s3/aws4_request',
    );
    expect(target.expiresAt.toISOString()).toBe('2026-09-20T12:00:30.000Z');
  });

  it('SIGNS the content type and length, so the target cannot be spent on something else', async () => {
    // This is what makes the `capture_media_objects` row written beforehand an
    // accurate description of what can arrive. A presigned PUT that pinned
    // neither would be an unbounded write permission for fifteen minutes.
    const target = await store().createUploadTarget({
      key: 'captures/2026/09/obj-1',
      contentType: 'image/jpeg',
      byteSize: 2048,
      ttlSeconds: 900,
    });
    const signedHeaders = new URL(target.url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toBe('content-length;content-type;host');
    expect(target.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': '2048' });
  });

  it('produces a different signature for a different size, key or type', async () => {
    const base = {
      key: 'captures/2026/09/obj-1',
      contentType: 'image/jpeg',
      byteSize: 2048,
      ttlSeconds: 900,
    };
    const signatureOf = async (request: typeof base) =>
      new URL((await store().createUploadTarget(request)).url).searchParams.get('X-Amz-Signature');

    const original = await signatureOf(base);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic given identical inputs, or the assertions below prove nothing.
    expect(await signatureOf(base)).toBe(original);
    expect(await signatureOf({ ...base, byteSize: 2049 })).not.toBe(original);
    expect(await signatureOf({ ...base, contentType: 'video/mp4' })).not.toBe(original);
    expect(await signatureOf({ ...base, key: 'captures/2026/09/obj-2' })).not.toBe(original);
  });

  it('carries a session token into the query for temporary credentials', async () => {
    // An ECS task role issues temporary credentials; a signer that dropped the
    // token would produce URLs S3 refuses, but only in the deployment that uses
    // them — never on a developer's machine with static keys.
    const temporary = store({
      bucket: 'goway-captures',
      region: 'eu-west-1',
      resolveCredentials: async () => ({ ...credentials, sessionToken: 'TEMP-TOKEN' }),
      now: () => FIXED_NOW,
    });
    const target = await temporary.createUploadTarget({
      key: 'captures/x',
      contentType: 'image/jpeg',
      byteSize: 1,
      ttlSeconds: 60,
    });
    expect(new URL(target.url).searchParams.get('X-Amz-Security-Token')).toBe('TEMP-TOKEN');
  });

  it('addresses an explicit endpoint path-style, so a local store needs no second code path', async () => {
    const local = store({
      bucket: 'goway-captures',
      region: 'eu-west-1',
      endpoint: 'http://127.0.0.1:9000',
      resolveCredentials: async () => credentials,
      now: () => FIXED_NOW,
    });
    const target = await local.createUploadTarget({
      key: 'captures/x',
      contentType: 'image/jpeg',
      byteSize: 1,
      ttlSeconds: 60,
    });
    const url = new URL(target.url);
    expect(url.protocol).toBe('http:');
    expect(url.host).toBe('127.0.0.1:9000');
    expect(url.pathname).toBe('/goway-captures/captures/x');
  });
});

describe('statObject', () => {
  it('reports the store’s own byte count, which is what finalize trusts', async () => {
    const stat = await store({
      bucket: 'b',
      region: 'r',
      resolveCredentials: async () => credentials,
      now: () => FIXED_NOW,
      fetchImpl: async () =>
        new Response(null, { status: 200, headers: { 'content-length': '2048', etag: '"abc"' } }),
    }).statObject('captures/x');
    expect(stat).toEqual({ byteSize: 2048, etag: 'abc' });
  });

  it('answers null for an object that is not there', async () => {
    // The orphan case: a finalize for bytes that never arrived must be a
    // refusable `conflict`, not an asset GoWay believes in.
    const stat = await store({
      bucket: 'b',
      region: 'r',
      resolveCredentials: async () => credentials,
      now: () => FIXED_NOW,
      fetchImpl: async () => new Response(null, { status: 404 }),
    }).statObject('captures/missing');
    expect(stat).toBeNull();
  });

  it('throws on any other failure rather than reporting an absence', async () => {
    // A 403 means "we could not look", which is a different fact from "it is
    // not there" — and reporting the second would let a permissions mistake
    // read as every contributor's upload having failed.
    const failing = store({
      bucket: 'b',
      region: 'r',
      resolveCredentials: async () => credentials,
      now: () => FIXED_NOW,
      fetchImpl: async () => new Response(null, { status: 403 }),
    });
    await expect(failing.statObject('captures/x')).rejects.toThrow('403');
  });
});

describe('deleteObject', () => {
  it('treats an absent object as deleted, because deletion is idempotent', async () => {
    const gone = store({
      bucket: 'b',
      region: 'r',
      resolveCredentials: async () => credentials,
      now: () => FIXED_NOW,
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    await expect(gone.deleteObject('captures/x')).resolves.toBeUndefined();
  });
});

describe('createEnvironmentCredentialsProvider', () => {
  it('prefers explicit environment credentials', async () => {
    const resolve = createEnvironmentCredentialsProvider({
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
    });
    expect(await resolve()).toEqual({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
  });

  it('falls back to the container credentials endpoint, which is what the deployment uses', async () => {
    let calls = 0;
    const resolve = createEnvironmentCredentialsProvider(
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' },
      async () => {
        calls += 1;
        return Response.json({
          AccessKeyId: 'ASIA',
          SecretAccessKey: 'temp',
          Token: 'session',
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        });
      },
    );
    expect(await resolve()).toEqual({
      accessKeyId: 'ASIA',
      secretAccessKey: 'temp',
      sessionToken: 'session',
    });
    // Cached until close to expiry: the endpoint is container-local, but a
    // credential fetched per signature is a per-upload round trip for nothing.
    await resolve();
    expect(calls).toBe(1);
  });

  it('refuses to sign with nothing rather than producing an unusable URL', async () => {
    const resolve = createEnvironmentCredentialsProvider({});
    await expect(resolve()).rejects.toThrow('No AWS credentials');
  });
});
