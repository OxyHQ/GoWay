/**
 * In-memory stand-ins for every Street 3D adapter, and a scripted worker.
 *
 * They implement the SAME GoWay interfaces the AWS adapters do, so the
 * scheduler under test cannot tell the difference — which is the point of the
 * seam. What they add is observability: what was sent, deleted, copied and
 * invalidated, so a test asserts the side effects a real queue or bucket would
 * silently accept.
 *
 * `FakeWorker` plays the external worker from the CONTRACT side only: it reads
 * envelopes off the fake jobs queue, writes outputs and results to the fake
 * temporary bucket, and posts events — never touching the database.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { StoredObjectStat } from '../../storage/objectStore';
import type { JobObjectStore } from '../jobObjectStore';
import { assertScopedKey, DERIVED_PREFIX, JOBS_PREFIX, serializeJson } from '../jobObjectStore';
import type { CdnInvalidator, CopyAssetRequest, SceneAssetStore } from '../sceneAssetStore';
import type { Street3dServices } from '../services';
import type { QueueMessage, QueueStats, ReceiveOptions, WorkQueue } from '../workQueue';
import {
  jobEnvelopeSchema,
  type CapturePrivacyJob,
  type JobEnvelope,
  type SceneReconstructJob,
  type WorkerEvent,
} from '../workerContract';

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export class FakeQueue implements WorkQueue {
  readonly visible: QueueMessage[] = [];
  readonly inFlight = new Map<string, QueueMessage>();
  readonly sent: { body: string; attributes: Record<string, string | number> }[] = [];
  readonly deleted: string[] = [];
  failSends = false;

  async send(body: string, attributes: Record<string, string | number> = {}) {
    if (this.failSends) throw new Error('queue unavailable https://sqs.invalid/secret');
    this.sent.push({ body, attributes });
    const messageId = randomUUID();
    this.visible.push({
      messageId,
      receiptHandle: `r-${messageId}`,
      body,
      receiveCount: 0,
      attributes: Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [key, String(value)]),
      ),
    });
    return { messageId };
  }

  async receive({ maxMessages }: ReceiveOptions) {
    const taken = this.visible
      .splice(0, maxMessages)
      .map((message) => ({ ...message, receiveCount: message.receiveCount + 1 }));
    for (const message of taken) this.inFlight.set(message.receiptHandle, message);
    return taken;
  }

  async delete(receiptHandle: string) {
    this.deleted.push(receiptHandle);
    this.inFlight.delete(receiptHandle);
  }

  async stats(): Promise<QueueStats> {
    return { visible: this.visible.length, inFlight: this.inFlight.size, delayed: 0 };
  }

  /** Return every in-flight message to the queue, as an expired visibility timeout would. */
  expireVisibility(): void {
    for (const message of this.inFlight.values()) this.visible.push(message);
    this.inFlight.clear();
  }

  /** Envelopes sent, parsed. */
  envelopes(): { envelope: JobEnvelope; attempt: number }[] {
    return this.sent.map((entry) => ({
      envelope: jobEnvelopeSchema.parse(JSON.parse(entry.body)),
      attempt: Number(entry.attributes.attempt),
    }));
  }
}

export class FakeJobStore implements JobObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];

  async putJson(key: string, value: unknown) {
    assertScopedKey(key, [JOBS_PREFIX]);
    const serialized = serializeJson(value);
    this.objects.set(key, Buffer.from(serialized.body, 'utf8'));
    return serialized;
  }

  /** What the worker does: write bytes anywhere under jobs/ or derived/. */
  put(key: string, bytes: Uint8Array | string): { sha256: string; byteSize: number } {
    assertScopedKey(key, [JOBS_PREFIX, DERIVED_PREFIX]);
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    this.objects.set(key, data);
    return { sha256: sha256(data), byteSize: data.byteLength };
  }

  async getBytes(key: string, maxBytes: number) {
    assertScopedKey(key, [JOBS_PREFIX, DERIVED_PREFIX]);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    if (bytes.byteLength > maxBytes) throw new Error('too large');
    return bytes;
  }

  async head(key: string): Promise<StoredObjectStat | null> {
    const bytes = this.objects.get(key);
    return bytes ? { byteSize: bytes.byteLength, checksumSha256: sha256(bytes) } : null;
  }

  async delete(key: string) {
    assertScopedKey(key, [JOBS_PREFIX, DERIVED_PREFIX]);
    this.deleted.push(key);
    this.objects.delete(key);
  }

  async list(prefix: string, limit: number) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit);
  }

  json(key: string): unknown {
    const bytes = this.objects.get(key);
    return bytes ? (JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown) : undefined;
  }
}

export class FakeSceneStore implements SceneAssetStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly copies: CopyAssetRequest[] = [];
  readonly deleted: string[] = [];

  constructor(private readonly staging: FakeJobStore) {}

  async copyFromStaging(request: CopyAssetRequest) {
    const bytes = this.staging.objects.get(request.sourceKey);
    if (!bytes) throw new Error('NoSuchKey');
    if (sha256(bytes) !== request.sha256 || bytes.byteLength !== request.byteSize)
      throw new Error('digest');
    this.copies.push(request);
    this.objects.set(request.destinationKey, { bytes, contentType: request.contentType });
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          byteSize: object.bytes.byteLength,
          checksumSha256: sha256(object.bytes),
          contentType: object.contentType,
        }
      : null;
  }

  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

export class FakeCdn implements CdnInvalidator {
  readonly invalidations: { paths: readonly string[]; callerReference: string }[] = [];
  async invalidate(paths: readonly string[], callerReference: string) {
    this.invalidations.push({ paths, callerReference });
  }
}

export interface FakeServices extends Street3dServices {
  jobsQueue: FakeQueue;
  eventsQueue: FakeQueue;
  deadLetterQueue: FakeQueue;
  jobStore: FakeJobStore;
  sceneStore: FakeSceneStore;
  cdn: FakeCdn;
}

export function fakeServices(): FakeServices {
  const jobStore = new FakeJobStore();
  return {
    jobsQueue: new FakeQueue(),
    eventsQueue: new FakeQueue(),
    deadLetterQueue: new FakeQueue(),
    jobStore,
    sceneStore: new FakeSceneStore(jobStore),
    cdn: new FakeCdn(),
  };
}

function event(
  job: { jobId: string },
  attempt: number,
  fields: Record<string, unknown>,
): WorkerEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    jobId: job.jobId,
    attempt,
    workerId: 'w-test',
    at: new Date().toISOString(),
    ...fields,
  } as WorkerEvent;
}

/** The external worker, scripted, speaking only the contract. */
export class FakeWorker {
  constructor(private readonly services: FakeServices) {}

  /** Envelopes currently waiting on the jobs queue, consumed. */
  async take(): Promise<{ envelope: JobEnvelope; attempt: number; receiptHandle: string }[]> {
    const messages = await this.services.jobsQueue.receive({ maxMessages: 10, waitSeconds: 0 });
    return messages.map((message) => ({
      envelope: jobEnvelopeSchema.parse(JSON.parse(message.body)),
      attempt: Number(message.attributes.attempt ?? '1'),
      receiptHandle: message.receiptHandle,
    }));
  }

  async post(value: WorkerEvent | string): Promise<WorkerEvent | null> {
    await this.services.eventsQueue.send(typeof value === 'string' ? value : JSON.stringify(value));
    return typeof value === 'string' ? null : value;
  }

  async heartbeat(job: { jobId: string }, attempt = 1, stage = 'training') {
    return this.post(event(job, attempt, { type: 'heartbeat', stage, progress: 0.5 }));
  }

  async fail(job: { jobId: string }, code: string, attempt = 1) {
    return this.post(
      event(job, attempt, {
        type: 'failed',
        stage: 'solving',
        failure: { code, retryable: false, detail: 'scripted /tmp/x https://x.invalid' },
      }),
    );
  }

  /** Write a result object and return the `completed` event for it (not yet posted). */
  completedEvent(job: { jobId: string }, attempt: number, result: unknown): WorkerEvent {
    const key = `jobs/${job.jobId}/attempt-${attempt}/result.json`;
    const written = this.services.jobStore.put(key, JSON.stringify(result));
    return event(job, attempt, {
      type: 'completed',
      result: { key, sha256: written.sha256, byteSize: written.byteSize },
    });
  }

  /**
   * Run a privacy job: frames written under its prefix, result written, event posted.
   *
   * `panorama` reports the frames as views of 360° panoramas (eight per
   * panorama, 45° apart) under a verified `equirectangular` projection;
   * without it the result names no projection, as a worker that predates 360°
   * captures would.
   */
  async completePrivacy(
    job: CapturePrivacyJob,
    options: {
      frames?: number;
      verdict?: 'passed' | 'failed';
      attempt?: number;
      seed?: string;
      panorama?: boolean;
    } = {},
  ): Promise<WorkerEvent> {
    const attempt = options.attempt ?? 1;
    const verdict = options.verdict ?? 'passed';
    const frames =
      verdict === 'passed'
        ? Array.from({ length: options.frames ?? 1 }, (_, frameIndex) => {
            const image = this.services.jobStore.put(
              `${job.outputPrefix}${String(frameIndex).padStart(6, '0')}.jpg`,
              `pixels:${job.assetId}:${frameIndex}:${options.seed ?? ''}`,
            );
            const mask = this.services.jobStore.put(
              `${job.outputPrefix}${String(frameIndex).padStart(6, '0')}.mask.png`,
              `mask:${job.assetId}:${frameIndex}`,
            );
            return {
              frameIndex,
              imageKey: `${job.outputPrefix}${String(frameIndex).padStart(6, '0')}.jpg`,
              imageSha256: image.sha256,
              imageByteSize: image.byteSize,
              maskKey: `${job.outputPrefix}${String(frameIndex).padStart(6, '0')}.mask.png`,
              maskSha256: mask.sha256,
              maskByteSize: mask.byteSize,
              ...(options.panorama
                ? {
                    width: 1280,
                    height: 960,
                    panorama: {
                      index: Math.floor(frameIndex / 8),
                      yawDegrees: (frameIndex % 8) * 45,
                      horizontalFovDegrees: 90,
                    },
                  }
                : { width: 2048, height: 1536 }),
            };
          })
        : [];
    const completed = this.completedEvent(job, attempt, {
      schemaVersion: 1,
      jobId: job.jobId,
      jobType: 'capture_privacy',
      attempt,
      assetId: job.assetId,
      verdict,
      privacyPipelineVersion: 'goway-privacy/1',
      ...(options.panorama ? { projection: 'equirectangular' } : {}),
      models: [{ name: 'face', version: '1', sha256: 'a'.repeat(64) }],
      metadataStripped: true,
      frames,
      rejectedFrames: 0,
    });
    await this.post(completed);
    return completed;
  }

  /**
   * A scene result: every manifest frame registered unless `registered` says
   * otherwise, the three assets written to the job's attempt prefix.
   */
  sceneResult(
    job: SceneReconstructJob,
    manifest: { frames: { frameId: string; imageSha256: string }[] },
    overrides: { attempt?: number; registered?: string[]; psnr?: number; splatBytes?: string } = {},
  ): Record<string, unknown> {
    const attempt = overrides.attempt ?? 1;
    const prefix = `jobs/${job.jobId}/attempt-${attempt}/`;
    const splat = this.services.jobStore.put(
      `${prefix}scene.spz`,
      overrides.splatBytes ?? `splat:${job.jobId}`,
    );
    const preview = this.services.jobStore.put(`${prefix}preview.spz`, `preview:${job.jobId}`);
    const poster = this.services.jobStore.put(`${prefix}poster.jpg`, `poster:${job.jobId}`);
    const registered = overrides.registered ?? manifest.frames.map((frame) => frame.frameId);
    const ids = manifest.frames.map((frame) => frame.frameId);
    return {
      schemaVersion: 1,
      jobId: job.jobId,
      jobType: 'scene_reconstruct',
      attempt,
      sceneId: job.sceneId,
      sceneVersion: job.sceneVersion,
      profile: job.profile,
      inputManifestSha256: job.inputManifestSha256,
      worldTransform: {
        anchor: { latitude: 48.8684, longitude: 2.302, altitudeMeters: 0 },
        frame: 'enu',
        enuFromScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      bounds: { west: 2.3008, south: 48.8678, east: 2.3032, north: 48.869 },
      footprint: {
        type: 'Polygon',
        coordinates: [
          [
            [2.3008, 48.8678],
            [2.3032, 48.8678],
            [2.3032, 48.869],
            [2.3008, 48.869],
            [2.3008, 48.8678],
          ],
        ],
      },
      frames: { input: ids.length, registered: registered.length, registeredFrameIds: registered },
      edges: ids.length >= 2 ? [{ a: ids[1], b: ids[0], inliers: 300 }] : [],
      metrics: {
        registrationRatio: registered.length / Math.max(1, ids.length),
        meanReprojectionErrorPx: 0.8,
        georeferenceInliers: 9,
        medianGeoreferenceResidualMeters: 1.4,
        heldOutPsnr: overrides.psnr ?? 21.3,
        gaussians: 800_000,
        gpuSeconds: 600,
        wallSeconds: 900,
        inputBytesDownloaded: 1000,
        cacheHitRatio: 0.5,
        outputBytes: splat.byteSize + preview.byteSize + poster.byteSize,
      },
      gates: { passed: true, failures: [] },
      assets: [
        {
          role: 'splat',
          format: 'spz',
          key: `${prefix}scene.spz`,
          sha256: splat.sha256,
          byteSize: splat.byteSize,
          contentType: 'application/octet-stream',
          gaussians: 800_000,
        },
        {
          role: 'splat_preview',
          format: 'spz',
          key: `${prefix}preview.spz`,
          sha256: preview.sha256,
          byteSize: preview.byteSize,
          contentType: 'application/octet-stream',
          gaussians: 150_000,
        },
        {
          role: 'poster',
          format: 'jpeg',
          key: `${prefix}poster.jpg`,
          sha256: poster.sha256,
          byteSize: poster.byteSize,
          contentType: 'image/jpeg',
        },
      ],
      initialView: { position: [0, 0, 1.6], target: [0, 10, 1.6] },
      // A walk back down the street, every half metre, as a capture sequence reports it.
      viewpoints: Array.from({ length: 21 }, (_, index) => ({
        position: [0.004, 10 - index * 0.5, 1.6],
        forward: [0, -2, 0],
      })),
      captureFieldOfView: { horizontalDegrees: 66, verticalDegrees: 50 },
      observedFrom: '2026-09-01T09:00:00.000Z',
      observedTo: '2026-09-02T10:00:00.000Z',
      provenance: {
        pipelineVersion: 'goway-reconstruction/1',
        privacyPipelineVersions: ['goway-privacy/1'],
        components: { sfm: 'sfm 1', trainer: 'trainer 1' },
        inputs: manifest.frames.map((frame) => ({
          frameId: frame.frameId,
          imageSha256: frame.imageSha256,
        })),
      },
    };
  }
}
