/**
 * How a guided recording is configured: resolution and bitrate against the
 * upload policy, the container a browser can produce that GoWay accepts, and
 * which camera controls can be locked.
 *
 * Pure, so the decisions are tested once and shared by the web and native
 * recorders rather than re-derived in each.
 */

// ── Budget ──────────────────────────────────────────────────────────────────

export interface VideoLimits {
  maxByteSize: number;
  maxDurationSeconds: number;
}

export type GuidedResolution = '2160p' | '1080p';

export const RESOLUTION_PIXELS: Readonly<
  Record<GuidedResolution, { width: number; height: number }>
> = {
  '2160p': { width: 3840, height: 2160 },
  '1080p': { width: 1920, height: 1080 },
};

/** What each resolution wants for clean H.264 at 30 fps; more buys little. */
export const RESOLUTION_BITRATE: Readonly<Record<GuidedResolution, number>> = {
  '2160p': 35_000_000,
  '1080p': 16_000_000,
};
/** Under this, 4K is worse for feature matching than 1080p at the same bitrate. */
export const UHD_MIN_BITRATE = 20_000_000;
/** Under this even 1080p turns to blocks; the byte limit stops the recording early instead. */
export const MIN_BITRATE = 4_000_000;

export interface RecordingBudget {
  resolution: GuidedResolution;
  bitsPerSecond: number;
  /** Stop at this duration, a little under the policy's limit. */
  maxSeconds: number;
  /** Stop when the recording reaches this size, leaving room for the last chunk and the index. */
  stopAtBytes: number;
  /** The longest the recording is expected to run, the earlier of the two limits. */
  expectedMaxSeconds: number;
}

/**
 * Fit the recording to the policy instead of letting it overflow.
 *
 * The whole loop is planned to fit one recording, so the bitrate is what the
 * byte limit affords over the duration limit. If that is enough for 4K, 4K;
 * otherwise 1080p at a bitrate it can use. A recording that would still
 * outgrow the byte limit is stopped before it does, so a guided capture never
 * produces a file the upload policy refuses.
 */
export function recordingBudget(limits: VideoLimits): RecordingBudget {
  const maxSeconds = Math.max(1, Math.floor(limits.maxDurationSeconds) - 2);
  const affordable = (limits.maxByteSize * 8 * 0.9) / maxSeconds;
  const resolution: GuidedResolution = affordable >= UHD_MIN_BITRATE ? '2160p' : '1080p';
  const bitsPerSecond = Math.round(
    Math.min(RESOLUTION_BITRATE[resolution], Math.max(MIN_BITRATE, affordable)),
  );
  const stopAtBytes = Math.max(0, Math.floor(limits.maxByteSize * 0.98 - (2 * bitsPerSecond) / 8));
  const expectedMaxSeconds = Math.min(maxSeconds, Math.floor((stopAtBytes * 8) / bitsPerSecond));
  return { resolution, bitsPerSecond, maxSeconds, stopAtBytes, expectedMaxSeconds };
}

/** Should a recording at `elapsedSeconds` and `bytes` stop now? */
export function reachedLimit(
  budget: RecordingBudget,
  elapsedSeconds: number,
  bytes: number,
): boolean {
  return elapsedSeconds >= budget.maxSeconds || bytes >= budget.stopAtBytes;
}

// ── Container ───────────────────────────────────────────────────────────────

/** `video/mp4;codecs=avc1` → `video/mp4`. */
export function baseContentType(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

const RECORDER_TYPES: Readonly<Record<GuidedResolution, readonly string[]>> = {
  // High profile at a level that covers the resolution, then whatever H.264
  // MP4 the browser offers. WebM is deliberately absent: GoWay does not accept
  // it, and a recording the upload refuses is worse than no recording.
  '2160p': [
    'video/mp4;codecs=avc1.640033',
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ],
  '1080p': ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4'],
};

/**
 * The first `MediaRecorder` type this browser supports whose container the
 * policy accepts, or `null` when there is none (Firefox records WebM only).
 */
export function pickRecorderType(
  isTypeSupported: (type: string) => boolean,
  acceptedContentTypes: readonly string[],
  resolution: GuidedResolution,
): { recorderType: string; contentType: string } | null {
  const accepted = new Set(acceptedContentTypes.map(baseContentType));
  for (const recorderType of RECORDER_TYPES[resolution]) {
    const contentType = baseContentType(recorderType);
    if (!accepted.has(contentType)) continue;
    let supported = false;
    try {
      supported = isTypeSupported(recorderType);
    } catch {
      supported = false;
    }
    if (supported) return { recorderType, contentType };
  }
  return null;
}

/** What the native camera writes: QuickTime on iOS, MP4 on Android. */
export function nativeRecording(os: string): { contentType: string; extension: string } {
  return os === 'ios'
    ? { contentType: 'video/quicktime', extension: 'mov' }
    : { contentType: 'video/mp4', extension: 'mp4' };
}

// ── Locks ───────────────────────────────────────────────────────────────────

export type LockFeature = 'exposure' | 'focus' | 'whiteBalance';
export type LockState = 'locked' | 'unavailable';

/**
 * The subset of `MediaTrackCapabilities` / `MediaTrackSettings` that the
 * MediaStream Image Capture extensions add. Not in TypeScript's DOM library,
 * and absent on most desktop browsers — every field is optional.
 */
export interface LockCapabilities {
  exposureMode?: readonly string[];
  focusMode?: readonly string[];
  whiteBalanceMode?: readonly string[];
  exposureTime?: unknown;
  iso?: unknown;
  focusDistance?: unknown;
  colorTemperature?: unknown;
}

export interface LockSettings {
  exposureTime?: number;
  iso?: number;
  focusDistance?: number;
  colorTemperature?: number;
}

export interface LockStep {
  feature: LockFeature;
  /** One constraint set, for `track.applyConstraints({ advanced: [constraint] })`. */
  constraint: Record<string, string | number>;
}

const LOCKS: readonly {
  feature: LockFeature;
  mode: 'exposureMode' | 'focusMode' | 'whiteBalanceMode';
  values: readonly (keyof LockSettings)[];
}[] = [
  { feature: 'exposure', mode: 'exposureMode', values: ['exposureTime', 'iso'] },
  { feature: 'focus', mode: 'focusMode', values: ['focusDistance'] },
  { feature: 'whiteBalance', mode: 'whiteBalanceMode', values: ['colorTemperature'] },
];

/**
 * How to lock each control the track supports, one step per control so a
 * camera that refuses one still locks the others.
 *
 * `manual` pinned to the CURRENT values is preferred: the preview has been
 * running, auto has settled on the street, and that is what to keep. Without
 * readable values, `single-shot` (adjust once, then hold) is the next best.
 * A control offering neither cannot be locked and is left on auto.
 */
export function lockSteps(capabilities: LockCapabilities, settings: LockSettings): LockStep[] {
  const steps: LockStep[] = [];
  for (const lock of LOCKS) {
    const modes = Array.isArray(capabilities[lock.mode]) ? (capabilities[lock.mode] ?? []) : [];
    const [primary] = lock.values;
    const primaryValue = settings[primary];
    if (
      modes.includes('manual') &&
      capabilities[primary] !== undefined &&
      typeof primaryValue === 'number' &&
      Number.isFinite(primaryValue)
    ) {
      const constraint: Record<string, string | number> = { [lock.mode]: 'manual' };
      for (const key of lock.values) {
        const value = settings[key];
        if (capabilities[key] !== undefined && typeof value === 'number' && Number.isFinite(value))
          constraint[key] = value;
      }
      steps.push({ feature: lock.feature, constraint });
    } else if (modes.includes('single-shot')) {
      steps.push({ feature: lock.feature, constraint: { [lock.mode]: 'single-shot' } });
    }
  }
  return steps;
}

export type LockReport = Readonly<Record<LockFeature, LockState>>;

export const NOTHING_LOCKED: LockReport = {
  exposure: 'unavailable',
  focus: 'unavailable',
  whiteBalance: 'unavailable',
};

/** Fold which steps the camera accepted into a report. */
export function lockReport(applied: readonly LockFeature[]): LockReport {
  const report = { ...NOTHING_LOCKED };
  for (const feature of applied) report[feature] = 'locked';
  return report;
}

/**
 * Did the camera actually take a lock step? `applyConstraints` skips an
 * `advanced` set it cannot satisfy WITHOUT rejecting, so success of the call
 * proves nothing; the settings read back afterwards are the evidence.
 */
export function lockHeld(
  step: LockStep,
  settingsAfter: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(step.constraint).every(([key, value]) =>
    key.endsWith('Mode') ? settingsAfter[key] === value : true,
  );
}

/** Message keys telling the user what was locked and what could not be. White balance is a silent bonus. */
export function lockNoticeKeys(report: LockReport): string[] {
  return [
    report.exposure === 'locked'
      ? 'contribute.guided.lock.exposure'
      : 'contribute.guided.lock.noExposure',
    report.focus === 'locked' ? 'contribute.guided.lock.focus' : 'contribute.guided.lock.noFocus',
  ];
}
