/**
 * The Street 3D AWS adapters, without an AWS account.
 *
 * What is asserted is what a wrong adapter would still "work" without: the
 * right SQS target and protocol, a signed body hash, prefix guards that refuse
 * a raw capture key before anything is signed, a copy that is verified rather
 * than trusted, the CopyObject 200-with-error quirk, and a CloudFront call in
 * the one region it is signed in.
 */

import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AwsFetch } from '../../aws/sigv4';
import { createS3JobObjectStore } from '../jobObjectStore';
import {
  createCloudFrontInvalidator,
  createS3SceneAssetStore,
  IMMUTABLE_CACHE_CONTROL,
  sceneAssetKey,
} from '../sceneAssetStore';
import { createSqsWorkQueue, QueueRequestError } from '../workQueue';

const credentials = async () => ({
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'token',
});
const now = () => new Date('2026-10-04T10:00:00.000Z');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(answer: (call: Call) => Response): { fetchImpl: AwsFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: AwsFetch = async (url, init) => {
    const call = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body:
        typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? Buffer.from(init.body).toString('utf8')
            : '',
    };
    calls.push(call);
    return answer(call);
  };
  return { fetchImpl, calls };
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('SQS work queue', () => {
  const queueUrl = 'https://sqs.eu-west-1.amazonaws.com/123456789012/goway-street3d-jobs';

  it('sends with the JSON protocol, a signed body and the attempt as a message attribute', async () => {
    const { fetchImpl, calls } = recorder((call) =>
      Response.json({ MessageId: 'm-1', MD5OfMessageBody: md5(JSON.parse(call.body).MessageBody) }),
    );
    const queue = createSqsWorkQueue({
      queueUrl,
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    expect(await queue.send('{"jobId":"x"}', { attempt: 2 })).toEqual({ messageId: 'm-1' });
    const [call] = calls;
    expect(call?.url).toBe('https://sqs.eu-west-1.amazonaws.com/');
    expect(call?.headers['x-amz-target']).toBe('AmazonSQS.SendMessage');
    expect(call?.headers['content-type']).toBe('application/x-amz-json-1.0');
    expect(call?.headers.authorization).toContain('/eu-west-1/sqs/aws4_request');
    expect(call?.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(call!.body).digest('hex'),
    );
    expect(JSON.parse(call!.body)).toEqual({
      QueueUrl: queueUrl,
      MessageBody: '{"jobId":"x"}',
      MessageAttributes: { attempt: { DataType: 'Number', StringValue: '2' } },
    });
  });

  it('refuses a send whose stored digest does not match', async () => {
    const { fetchImpl } = recorder(() =>
      Response.json({ MessageId: 'm-1', MD5OfMessageBody: 'nope' }),
    );
    const queue = createSqsWorkQueue({
      queueUrl,
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    await expect(queue.send('{}')).rejects.toBeInstanceOf(QueueRequestError);
  });

  it('long-polls, reads receive counts and attributes, and treats an expired receipt as deleted', async () => {
    const { fetchImpl, calls } = recorder((call) => {
      const target = call.headers['x-amz-target'];
      if (target === 'AmazonSQS.ReceiveMessage') {
        return Response.json({
          Messages: [
            {
              MessageId: 'm',
              ReceiptHandle: 'r',
              Body: '{}',
              Attributes: { ApproximateReceiveCount: '3' },
              MessageAttributes: { attempt: { StringValue: '2', DataType: 'Number' } },
            },
          ],
        });
      }
      if (target === 'AmazonSQS.DeleteMessage') {
        return Response.json(
          { __type: 'com.amazonaws.sqs#ReceiptHandleIsInvalid', message: 'x' },
          { status: 400 },
        );
      }
      return Response.json({
        Attributes: {
          ApproximateNumberOfMessages: '5',
          ApproximateNumberOfMessagesNotVisible: '2',
          ApproximateNumberOfMessagesDelayed: '0',
        },
      });
    });
    const queue = createSqsWorkQueue({
      queueUrl,
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    const [message] = await queue.receive({ maxMessages: 50, waitSeconds: 30 });
    expect(message).toMatchObject({ receiveCount: 3, attributes: { attempt: '2' } });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
    });
    await queue.delete('r');
    expect(await queue.stats()).toEqual({ visible: 5, inFlight: 2, delayed: 0 });
  });

  it('reports the error type, never the body', async () => {
    const { fetchImpl } = recorder(() =>
      Response.json(
        { __type: 'com.amazonaws.sqs#AccessDenied', message: 'arn:aws:secret' },
        { status: 403 },
      ),
    );
    const queue = createSqsWorkQueue({
      queueUrl,
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    const message = await queue.stats().then(
      () => 'resolved',
      (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
    );
    expect(message).toContain('AccessDenied');
    expect(message).not.toContain('arn:aws');
  });
});

describe('job object store', () => {
  it('writes JSON only under jobs/, with an S3-verified checksum', async () => {
    const { fetchImpl, calls } = recorder(() => new Response(null, { status: 200 }));
    const store = createS3JobObjectStore({
      bucket: 'goway-temp',
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    const written = await store.putJson('jobs/j-1/input.json', { a: 1 });
    expect(written.sha256).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(calls[0]?.url).toBe('https://goway-temp.s3.eu-west-1.amazonaws.com/jobs/j-1/input.json');
    expect(calls[0]?.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(written.sha256, 'hex').toString('base64'),
    );
    await expect(store.putJson('derived/x.json', {})).rejects.toThrow('outside');
    await expect(store.delete('captures/2026/10/raw')).rejects.toThrow('outside');
    await expect(store.getBytes('jobs/../captures/raw', 10)).rejects.toThrow('outside');
    expect(calls).toHaveLength(1);
  });

  it('refuses a read over the ceiling and a delete that left a version marker', async () => {
    const { fetchImpl } = recorder((call) =>
      call.method === 'GET'
        ? new Response('x'.repeat(100), { headers: { 'content-length': '100' } })
        : new Response(null, { status: 204, headers: { 'x-amz-delete-marker': 'true' } }),
    );
    const store = createS3JobObjectStore({
      bucket: 'goway-temp',
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    await expect(store.getBytes('jobs/j/result.json', 10)).rejects.toThrow('ceiling');
    await expect(store.delete('derived/privacy/a/b/0.jpg')).rejects.toThrow('version marker');
  });

  it('lists every page of a prefix', async () => {
    let page = 0;
    const { fetchImpl, calls } = recorder(() => {
      page += 1;
      return new Response(
        page === 1
          ? '<ListBucketResult><Key>jobs/j/a</Key><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>'
          : '<ListBucketResult><Key>jobs/j/b&amp;c</Key><IsTruncated>false</IsTruncated></ListBucketResult>',
      );
    });
    const store = createS3JobObjectStore({
      bucket: 'goway-temp',
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    expect(await store.list('jobs/j/', 100)).toEqual(['jobs/j/a', 'jobs/j/b&c']);
    expect(new URL(calls[1]!.url).searchParams.get('continuation-token')).toBe('t2');
  });
});

describe('scene asset store', () => {
  const digest = 'c'.repeat(64);
  const key = sceneAssetKey('scenes', 'scene-1', 3, digest, 'spz');

  it('names assets by content and copies with an immutable policy, then verifies', async () => {
    expect(key).toBe(`scenes/scene-1/v3/${digest}.spz`);
    const { fetchImpl, calls } = recorder((call) =>
      call.method === 'HEAD'
        ? new Response(null, {
            headers: {
              'content-length': '42',
              'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
            },
          })
        : new Response('<CopyObjectResult/>'),
    );
    const store = createS3SceneAssetStore({
      sceneBucket: 'goway-scenes',
      scenePrefix: 'scenes',
      stagingBucket: 'goway-temp',
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    await store.copyFromStaging({
      sourceKey: 'jobs/j/attempt-1/scene.spz',
      destinationKey: key,
      contentType: 'application/octet-stream',
      sha256: digest,
      byteSize: 42,
    });
    const copy = calls[0]!;
    expect(copy.url).toBe(`https://goway-scenes.s3.eu-west-1.amazonaws.com/${key}`);
    expect(copy.headers['x-amz-copy-source']).toBe('/goway-temp/jobs/j/attempt-1/scene.spz');
    expect(copy.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(copy.headers['x-amz-metadata-directive']).toBe('REPLACE');
    expect(calls[1]?.method).toBe('HEAD');
  });

  it('treats a 200 carrying an <Error> as a failed copy, and refuses keys outside its prefixes', async () => {
    const { fetchImpl } = recorder(() => new Response('<Error><Code>InternalError</Code></Error>'));
    const store = createS3SceneAssetStore({
      sceneBucket: 'goway-scenes',
      scenePrefix: 'scenes',
      stagingBucket: 'goway-temp',
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    await expect(
      store.copyFromStaging({
        sourceKey: 'jobs/j/a.spz',
        destinationKey: key,
        contentType: 'application/octet-stream',
        sha256: digest,
        byteSize: 1,
      }),
    ).rejects.toThrow('InternalError');
    await expect(
      store.copyFromStaging({
        sourceKey: 'captures/raw',
        destinationKey: key,
        contentType: 'x',
        sha256: digest,
        byteSize: 1,
      }),
    ).rejects.toThrow('outside');
    await expect(store.delete('captures/raw')).rejects.toThrow('outside');
  });

  it('refuses a copy whose size or digest differs from what was validated', async () => {
    const { fetchImpl } = recorder((call) =>
      call.method === 'HEAD'
        ? new Response(null, {
            headers: {
              'content-length': '42',
              'x-amz-checksum-sha256': Buffer.from('d'.repeat(64), 'hex').toString('base64'),
            },
          })
        : new Response('<CopyObjectResult/>'),
    );
    const store = createS3SceneAssetStore({
      sceneBucket: 'goway-scenes',
      scenePrefix: 'scenes',
      stagingBucket: 'goway-temp',
      region: 'eu-west-1',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    await expect(
      store.copyFromStaging({
        sourceKey: 'jobs/j/a.spz',
        destinationKey: key,
        contentType: 'application/octet-stream',
        sha256: digest,
        byteSize: 42,
      }),
    ).rejects.toThrow('digest');
  });
});

describe('CloudFront invalidation', () => {
  it('signs in us-east-1 and sends the paths with an idempotent caller reference', async () => {
    const { fetchImpl, calls } = recorder(() => new Response('<Invalidation/>', { status: 201 }));
    const cdn = createCloudFrontInvalidator({
      distributionId: 'E2EXAMPLE123',
      resolveCredentials: credentials,
      fetchImpl,
      now,
    });
    await cdn.invalidate(['/street3d/scenes/s/v1/*'], 'goway-street3d-disable-v1');
    const [call] = calls;
    expect(call?.url).toBe(
      'https://cloudfront.amazonaws.com/2020-05-31/distribution/E2EXAMPLE123/invalidation',
    );
    expect(call?.headers.authorization).toContain('/us-east-1/cloudfront/aws4_request');
    expect(call?.body).toContain(
      '<Quantity>1</Quantity><Items><Path>/street3d/scenes/s/v1/*</Path></Items>',
    );
    expect(call?.body).toContain('<CallerReference>goway-street3d-disable-v1</CallerReference>');
  });
});
