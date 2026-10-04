/**
 * The ONE seam between the app and the Street 3D API.
 *
 * `@goway.to/sdk` is gaining `client.street3d.{coverage, scene, report}`. Until
 * the release that carries it is what this app installs, this adapter performs
 * the same three requests itself — same paths under `/api/v1`, same query
 * names, same typed SDK errors — so every screen is written against the final
 * shape and `classifyGoWayError` works unchanged.
 *
 * Switching to the SDK is already automatic: {@link createStreet3dApi} prefers
 * `client.street3d` whenever the client it is given has one. Once the SDK ships
 * it, delete the fallback half of this file and keep the interface.
 *
 * Kept free of React Native and of the app's singletons so it is unit-tested
 * against the fixture transport (`lib/goway/mockTransport.ts`) directly.
 */
import {
  GOWAY_API_BASE_PATH,
  GoWayAbortError,
  GoWayApiError,
  GoWayConflictError,
  GoWayForbiddenError,
  GoWayNetworkError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayResponseError,
  GoWayTimeoutError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayValidationError,
  type GeoBoundingBox,
  type GoWayAccessTokenGetter,
  type GoWayFetch,
  type GoWayFetchInit,
  type GoWayRequestOptions,
} from '@goway.to/sdk';
import {
  STREET_COVERAGE_AREA_STATES,
  STREET_SCENE_REPORT_REASONS,
  type StreetCoverage,
  type StreetCoverageArea,
  type StreetSceneAsset,
  type StreetSceneId,
  type StreetSceneManifest,
  type StreetSceneReport,
  type StreetSceneReportInput,
  type StreetSceneSummary,
} from '@goway/shared-types';

/** What the app needs from Street 3D. The SDK's `client.street3d` has this shape. */
export interface Street3dApi {
  coverage(query: GeoBoundingBox, options?: GoWayRequestOptions): Promise<StreetCoverage>;
  scene(id: StreetSceneId, options?: GoWayRequestOptions): Promise<StreetSceneManifest>;
  report(id: StreetSceneId, input: StreetSceneReportInput, options?: GoWayRequestOptions): Promise<StreetSceneReport>;
}

export interface Street3dApiOptions {
  /** A GoWay client; its `street3d` namespace is used when it has one. */
  client?: unknown;
  apiBaseUrl: string;
  /** Transport for public reads. Defaults to the global `fetch`. */
  fetch?: GoWayFetch;
  /**
   * Transport for identity-bound writes (`report`). Defaults to {@link fetch}.
   * The app passes the Oxy linked client here, as the capture client does, so
   * Oxy stays the session authority. When it differs from {@link fetch} it is
   * trusted to authenticate itself and `getAccessToken` is not consulted.
   */
  writeFetch?: GoWayFetch;
  getAccessToken?: GoWayAccessTokenGetter;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPORT_NOTE = 500;

/** The SDK's namespace, when the installed SDK has one. */
function sdkNamespace(client: unknown): Street3dApi | null {
  if (typeof client !== 'object' || client === null) return null;
  const candidate = (client as { street3d?: Partial<Street3dApi> }).street3d;
  if (
    candidate &&
    typeof candidate.coverage === 'function' &&
    typeof candidate.scene === 'function' &&
    typeof candidate.report === 'function'
  ) {
    return candidate as Street3dApi;
  }
  return null;
}

export function createStreet3dApi(options: Street3dApiOptions): Street3dApi {
  const sdk = sdkNamespace(options.client);
  if (sdk) return sdk;
  return createFallbackApi(options);
}

// ── The fallback: the same requests the SDK will make ──────────────────────

interface Spec {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, number>;
  body?: unknown;
  write?: boolean;
  signal?: GoWayRequestOptions['signal'];
}

function serialize(query: Record<string, number> | undefined): string {
  if (!query) return '';
  // Sorted keys, as the SDK serialises, so a CDN or cache keys both alike.
  const parts = Object.keys(query)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function segment(id: string): string {
  if (typeof id !== 'string' || id.trim() === '' || id === '.' || id === '..') {
    throw new GoWayValidationError('sceneId must be a non-empty string');
  }
  return encodeURIComponent(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The SDK's status → class mapping, reduced to what these three routes return. */
export function street3dErrorFor(status: number, body: unknown): Error {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const message = typeof envelope?.message === 'string'
    ? `GoWay API error (HTTP ${status}): ${envelope.message.slice(0, 200)}`
    : `GoWay API responded with HTTP ${status}`;
  if (status === 400 || status === 422) return new GoWayValidationError(message, { status, code: 'bad_request' });
  if (status === 401) return new GoWayUnauthorizedError(message, { status });
  if (status === 403) return new GoWayForbiddenError(message, { status });
  // Only GoWay may say "this does not exist": a bare 404 from a proxy, or from
  // a backend that predates these routes, is an API error, not NotFound.
  if (status === 404) {
    return envelope?.code === 'not_found'
      ? new GoWayNotFoundError(message, { status })
      : new GoWayApiError(`GoWay API responded with HTTP ${status} without a GoWay error body`, { status });
  }
  if (status === 409) return new GoWayConflictError(message, { status });
  if (status === 429) return new GoWayRateLimitError(message, { status });
  if (status >= 500 && status !== 501 && status !== 505) return new GoWayUnavailableError(message, { status });
  return new GoWayApiError(message, { status });
}

function createFallbackApi(options: Street3dApiOptions): Street3dApi {
  const base = `${options.apiBaseUrl.replace(/\/+$/, '')}${GOWAY_API_BASE_PATH}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(spec: Spec, parse: (data: unknown) => T): Promise<T> {
    const { signal } = spec;
    if (signal?.aborted) throw new GoWayAbortError('The request was aborted before it was sent');
    const transport = (spec.write ? options.writeFetch : undefined) ?? options.fetch ??
      (typeof fetch === 'function' ? (fetch as unknown as GoWayFetch) : undefined);
    if (!transport) throw new TypeError('No fetch implementation is available');

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let reason: 'aborted' | 'timeout' | null = null;
    const onAbort = () => {
      reason = 'aborted';
      controller?.abort();
    };
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      reason = 'timeout';
      controller?.abort();
    }, timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      // Per request, never stored — the SDK's own token rule. A dedicated write
      // transport (the Oxy linked client) authenticates itself, so it is not
      // handed a second, possibly staler, bearer.
      const ownsAuth = spec.write === true && options.writeFetch !== undefined && options.writeFetch !== options.fetch;
      const token = !ownsAuth && options.getAccessToken ? await options.getAccessToken() : null;
      if (token) headers.Authorization = `Bearer ${token}`;
      const init: GoWayFetchInit = {
        method: spec.method,
        headers,
        credentials: 'omit',
        redirect: 'follow',
        ...(controller ? { signal: controller.signal } : {}),
      };
      if (spec.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(spec.body);
      }

      let text: string;
      let status: number;
      try {
        const response = await transport(`${base}${spec.path}${serialize(spec.query)}`, init);
        status = response.status;
        text = await response.text();
      } catch (error) {
        if (reason === 'timeout') throw new GoWayTimeoutError(`The request to GoWay timed out after ${timeoutMs} ms`);
        if (reason === 'aborted' || signal?.aborted) throw new GoWayAbortError('The request was aborted');
        throw new GoWayNetworkError('The request to GoWay could not be completed', { cause: error });
      }

      let body: unknown;
      try {
        body = text.trim() === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (status < 200 || status >= 300) throw street3dErrorFor(status, body);
      try {
        return parse(body);
      } catch (error) {
        throw new GoWayResponseError(
          `GoWay returned a malformed response: ${error instanceof Error ? error.message : 'invalid'}`,
          { status, cause: error },
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    coverage: (query, o = {}) => {
      for (const key of ['west', 'south', 'east', 'north'] as const) {
        if (!Number.isFinite(query[key])) throw new GoWayValidationError(`${key} must be a finite number`);
      }
      return call(
        {
          method: 'GET',
          path: '/street3d/coverage',
          query: { west: query.west, south: query.south, east: query.east, north: query.north },
          signal: o.signal,
        },
        parseCoverage,
      );
    },
    scene: (id, o = {}) =>
      call({ method: 'GET', path: `/street3d/scenes/${segment(id)}`, signal: o.signal }, parseManifest),
    report: (id, input, o = {}) => {
      if (!STREET_SCENE_REPORT_REASONS.includes(input.reason)) {
        throw new GoWayValidationError('reason is not a report reason');
      }
      const note = input.note?.trim();
      if (note && note.length > MAX_REPORT_NOTE) {
        throw new GoWayValidationError(`note must be at most ${MAX_REPORT_NOTE} characters`);
      }
      return call(
        {
          method: 'POST',
          path: `/street3d/scenes/${segment(id)}/reports`,
          body: note ? { reason: input.reason, note } : { reason: input.reason },
          write: true,
          signal: o.signal,
        },
        parseReport,
      );
    },
  };
}

// ── Parsing: enough to refuse a shape the UI would crash on ────────────────
//
// Deliberately not a full schema: the SDK release owns that. These check what
// the viewer and the map read, so a malformed response is a typed error at the
// boundary rather than a `TypeError` inside a render.

class ShapeError extends Error {}

function expect(condition: unknown, what: string): asserts condition {
  if (!condition) throw new ShapeError(what);
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function checkBounds(value: unknown, path: string): void {
  expect(isRecord(value), `${path} is not a bounding box`);
  for (const key of ['west', 'south', 'east', 'north']) expect(isNumber(value[key]), `${path}.${key} is not a number`);
}

function checkCoordinate(value: unknown, path: string): void {
  expect(isRecord(value) && isNumber(value.latitude) && isNumber(value.longitude), `${path} is not a coordinate`);
}

function checkPolygon(value: unknown, path: string): void {
  expect(isRecord(value) && value.type === 'Polygon' && Array.isArray(value.coordinates), `${path} is not a Polygon`);
}

function parseSummary(value: unknown, index: number): StreetSceneSummary {
  const path = `scenes[${index}]`;
  expect(isRecord(value), `${path} is not an object`);
  expect(isString(value.id) && value.id !== '', `${path}.id is missing`);
  expect(isNumber(value.version), `${path}.version is missing`);
  checkCoordinate(value.center, `${path}.center`);
  checkBounds(value.bounds, `${path}.bounds`);
  checkPolygon(value.footprint, `${path}.footprint`);
  expect(value.placement === 'precise' || value.placement === 'approximate', `${path}.placement is invalid`);
  return value as unknown as StreetSceneSummary;
}

function parseArea(value: unknown, index: number): StreetCoverageArea | null {
  const path = `areas[${index}]`;
  expect(isRecord(value), `${path} is not an object`);
  // An area state this build does not know is skipped, not fatal: the API may
  // add a state before the app learns to draw it.
  if (!STREET_COVERAGE_AREA_STATES.includes(value.state as never)) return null;
  expect(isString(value.id), `${path}.id is missing`);
  checkCoordinate(value.center, `${path}.center`);
  checkBounds(value.bounds, `${path}.bounds`);
  return value as unknown as StreetCoverageArea;
}

export function parseCoverage(data: unknown): StreetCoverage {
  expect(isRecord(data), 'coverage is not an object');
  expect(Array.isArray(data.scenes) && Array.isArray(data.areas), 'coverage needs scenes and areas');
  return {
    scenes: data.scenes.map(parseSummary),
    areas: data.areas.map(parseArea).filter((area): area is StreetCoverageArea => area !== null),
  };
}

function checkAsset(value: unknown, index: number): StreetSceneAsset {
  const path = `assets[${index}]`;
  expect(isRecord(value), `${path} is not an object`);
  expect(value.role === 'splat' || value.role === 'splat_preview' || value.role === 'poster', `${path}.role is invalid`);
  expect(isString(value.url) && value.url !== '', `${path}.url is missing`);
  expect(isNumber(value.byteSize), `${path}.byteSize is missing`);
  return value as unknown as StreetSceneAsset;
}

export function parseManifest(data: unknown): StreetSceneManifest {
  expect(isRecord(data), 'scene is not an object');
  expect(isString(data.id) && data.id !== '', 'scene.id is missing');
  expect(isNumber(data.version), 'scene.version is missing');
  checkBounds(data.bounds, 'scene.bounds');
  checkPolygon(data.footprint, 'scene.footprint');
  const transform = data.worldTransform;
  expect(isRecord(transform), 'scene.worldTransform is missing');
  checkCoordinate(transform.anchor, 'scene.worldTransform.anchor');
  expect(isRecord(transform.anchor) && isNumber(transform.anchor.altitudeMeters), 'anchor.altitudeMeters is missing');
  expect(
    Array.isArray(transform.enuFromScene) && transform.enuFromScene.length === 16 && transform.enuFromScene.every(isNumber),
    'scene.worldTransform.enuFromScene is not a 4×4 matrix',
  );
  const view = data.initialView;
  const isVec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(isNumber);
  expect(isRecord(view) && isVec3(view.position) && isVec3(view.target), 'scene.initialView is invalid');
  expect(Array.isArray(data.assets), 'scene.assets is missing');
  data.assets.forEach(checkAsset);
  expect(isRecord(data.quality), 'scene.quality is missing');
  expect(Array.isArray(data.attributions) && data.attributions.every(isString), 'scene.attributions is invalid');
  return data as unknown as StreetSceneManifest;
}

export function parseReport(data: unknown): StreetSceneReport {
  expect(isRecord(data) && isString(data.id) && isString(data.sceneId), 'report is invalid');
  return data as unknown as StreetSceneReport;
}
