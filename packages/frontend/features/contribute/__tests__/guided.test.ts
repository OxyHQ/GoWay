import { describe, expect, it } from 'bun:test';
import { blurryFraction, coachWarnings, DEFAULT_COACH_CONFIG, initialCoach, stepCoach, type CoachSample, type CoachState } from '../guided/coach';
import {
  advancePlan, currentStep, formatClock, GUIDED_STEPS, hasStretchTarget, isLastStep, startPlan, stepMessageKey, stepSeconds, stepStatus, stretchPace,
} from '../guided/plan';
import {
  baseContentType, lockHeld, lockNoticeKeys, lockReport, lockSteps, nativeRecording, pickRecorderType, reachedLimit, recordingBudget,
} from '../guided/recording';
import { centreCrop, frameSignals, laplacianVariance, meanLuma, sampleSize, toLuma } from '../guided/sharpness';
import { STREET3D_EN, STREET3D_ES } from '@/lib/messages/street3d';

/** An RGBA image whose grey level is `f(x, y)`. */
function image(width: number, height: number, f: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = f(x, y);
      data[p + 3] = 255;
    }
  }
  return data;
}

/** A 3-tap horizontal box blur, repeated: what fast panning does to a frame. */
function blurred(width: number, height: number, f: (x: number, y: number) => number, passes: number) {
  let grid = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => f(x, y)));
  for (let pass = 0; pass < passes; pass += 1) {
    grid = grid.map((row) => row.map((_, x) => (row[Math.max(0, x - 1)] + row[x] + row[Math.min(width - 1, x + 1)]) / 3));
  }
  return image(width, height, (x, y) => grid[y][x]);
}

const checker = (x: number, y: number) => ((Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 40 : 210);

describe('frame signals', () => {
  it('computes Rec. 601 luma and the mean brightness', () => {
    const luma = toLuma([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0], 2, 2);
    expect(Array.from(luma).map((v) => Math.round(v))).toEqual([76, 150, 29, 255]);
    expect(meanLuma([10, 20, 30])).toBe(20);
    expect(meanLuma([])).toBe(0);
    expect(() => toLuma([0, 0, 0], 1, 1)).toThrow();
  });

  it('scores a flat image 0, and a sharp image far above its blurred copy', () => {
    expect(laplacianVariance(new Float32Array(25).fill(128), 5, 5)).toBe(0);
    expect(laplacianVariance(new Float32Array(4), 2, 2)).toBe(0);
    const sharp = frameSignals(image(64, 36, checker), 64, 36);
    const soft = frameSignals(blurred(64, 36, checker, 4), 64, 36);
    expect(sharp.sharpness).toBeGreaterThan(soft.sharpness * 4);
    expect(sharp.brightness).toBeCloseTo(125, 0);
  });

  it('samples the centre half of the frame at a bounded size', () => {
    expect(centreCrop(3840, 2160)).toEqual({ x: 960, y: 540, width: 1920, height: 1080 });
    expect(sampleSize(1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(sampleSize(200, 100)).toEqual({ width: 200, height: 100 });
  });
});

describe('coach state machine', () => {
  const feed = (samples: CoachSample[], from: CoachState = initialCoach()) => samples.reduce((state, sample) => stepCoach(state, sample), from);
  const steady = (t0: number, count: number, sharpness: number, brightness = 120) =>
    Array.from({ length: count }, (_, i) => ({ t: t0 + i * 250, sharpness, brightness }));

  it('warns about blur only after it lasts more than half a second, and clears once sharp again', () => {
    let state = feed(steady(0, 8, 600));
    expect(coachWarnings(state, 1750)).toEqual([]);
    // 250 ms of blur: one bad frame is not a warning.
    state = feed(steady(2000, 2, 50), state);
    expect(state.blurry).toBe(false);
    state = feed(steady(2500, 2, 50), state);
    expect(state.blurry).toBe(true);
    expect(coachWarnings(state, 2750)).toContain('blur');
    // A sharp frame alone does not clear it either.
    state = feed(steady(3000, 2, 600), state);
    expect(state.blurry).toBe(true);
    state = feed(steady(3500, 3, 600), state);
    expect(state.blurry).toBe(false);
  });

  it('judges blur relative to the recent sharp reference, with an absolute floor', () => {
    // A low-detail scene that is steady is NOT blurry: the reference follows it.
    expect(feed(steady(0, 20, 80)).blurry).toBe(false);
    // Under the floor is blurry whatever the reference.
    expect(feed(steady(0, 6, DEFAULT_COACH_CONFIG.blurFloor - 1)).blurry).toBe(true);
    // A drop to a quarter of a sharp scene is blurry even above the floor.
    expect(feed(steady(1000, 4, 200), feed(steady(0, 4, 800))).blurry).toBe(true);
  });

  it('flags exposure jumps for a while and counts them', () => {
    let state = feed(steady(0, 4, 600, 100));
    state = stepCoach(state, { t: 1000, sharpness: 600, brightness: 160 });
    expect(coachWarnings(state, 1000)).toEqual(['exposure']);
    expect(coachWarnings(state, 1000 + DEFAULT_COACH_CONFIG.exposureHoldMs)).toEqual([]);
    expect(state.exposureJumps).toBe(1);
    // A slow drift is not a jump.
    expect(feed(Array.from({ length: 20 }, (_, i) => ({ t: i * 250, sharpness: 600, brightness: 100 + i * 3 }))).exposureJumps).toBe(0);
  });

  it('warns when the scene stays too dark', () => {
    const state = feed(steady(0, 6, 600, 10));
    expect(coachWarnings(state, 1250)).toEqual(['dark']);
  });

  it('restarts its timers after a pause and ignores invalid samples', () => {
    let state = feed(steady(0, 3, 30));
    state = stepCoach(state, { t: 60_000, sharpness: 30, brightness: 120 });
    expect(state.blurry).toBe(false);
    expect(state.runSince).toBeNull();
    expect(stepCoach(state, { t: NaN, sharpness: 1, brightness: 1 })).toBe(state);
  });

  it('reports the blurry share of the recording', () => {
    expect(blurryFraction(initialCoach())).toBe(0);
    const state = feed([...steady(0, 9, 600), ...steady(2250, 9, 10)]);
    expect(blurryFraction(state)).toBeGreaterThan(0.2);
    expect(blurryFraction(state)).toBeLessThan(0.5);
  });
});

describe('step plan', () => {
  it('walks the loop in order and stays on the last step', () => {
    let plan = startPlan(0);
    expect(currentStep(plan)).toBe('left');
    expect(stepSeconds(plan, 90_000)).toBe(90);
    plan = advancePlan(plan, 150_000);
    expect(currentStep(plan)).toBe('right');
    expect(stepSeconds(plan, 180_000)).toBe(30);
    expect([0, 1, 2].map((i) => stepStatus(plan, i))).toEqual(['done', 'current', 'todo']);
    plan = advancePlan(advancePlan(advancePlan(plan, 200_000), 300_000), 400_000);
    expect(currentStep(plan)).toBe('finish');
    expect(isLastStep(plan)).toBe(true);
    expect(plan.index).toBe(GUIDED_STEPS.length - 1);
  });

  it('paces each stretch against 2–3 minutes, except the finish', () => {
    expect(stretchPace(60)).toBe('short');
    expect(stretchPace(150)).toBe('onTarget');
    expect(stretchPace(181)).toBe('long');
    expect(hasStretchTarget('finish')).toBe(false);
    expect(hasStretchTarget('left')).toBe(true);
  });

  it('formats the clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(125.7)).toBe('2:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
  });
});

describe('recording configuration', () => {
  it('fits bitrate and resolution to the upload policy', () => {
    const tight = recordingBudget({ maxByteSize: 512 * 1024 * 1024, maxDurationSeconds: 600 });
    expect(tight.resolution).toBe('1080p');
    expect(tight.maxSeconds).toBe(598);
    expect(tight.expectedMaxSeconds).toBe(598);
    expect(tight.bitsPerSecond * tight.maxSeconds / 8).toBeLessThan(tight.stopAtBytes);

    const roomy = recordingBudget({ maxByteSize: 8 * 1024 ** 3, maxDurationSeconds: 1200 });
    expect(roomy.resolution).toBe('2160p');
    expect(roomy.bitsPerSecond).toBe(35_000_000);

    // When even the minimum bitrate cannot last the duration, the byte limit stops it first.
    const small = recordingBudget({ maxByteSize: 100 * 1024 * 1024, maxDurationSeconds: 3600 });
    expect(small.bitsPerSecond).toBe(4_000_000);
    expect(small.expectedMaxSeconds).toBeLessThan(small.maxSeconds);
    expect(reachedLimit(small, 10, small.stopAtBytes)).toBe(true);
    expect(reachedLimit(small, small.maxSeconds, 0)).toBe(true);
    expect(reachedLimit(small, 10, 0)).toBe(false);
  });

  it('records only containers the policy accepts', () => {
    const accepted = ['video/mp4', 'video/quicktime'];
    expect(baseContentType('Video/MP4; codecs=avc1')).toBe('video/mp4');
    expect(pickRecorderType((t) => t === 'video/mp4', accepted, '1080p')).toEqual({ recorderType: 'video/mp4', contentType: 'video/mp4' });
    expect(pickRecorderType(() => true, accepted, '2160p')?.recorderType).toBe('video/mp4;codecs=avc1.640033');
    expect(pickRecorderType((t) => t.startsWith('video/webm'), accepted, '1080p')).toBeNull();
    expect(pickRecorderType(() => true, ['video/quicktime'], '1080p')).toBeNull();
    expect(pickRecorderType(() => { throw new Error('old browser'); }, accepted, '1080p')).toBeNull();
    expect(nativeRecording('ios')).toEqual({ contentType: 'video/quicktime', extension: 'mov' });
    expect(nativeRecording('android').contentType).toBe('video/mp4');
  });

  it('locks to current values, falls back to single-shot, and skips what cannot lock', () => {
    const steps = lockSteps(
      { exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 1000 }, iso: { min: 50, max: 3200 }, focusMode: ['continuous', 'single-shot'], whiteBalanceMode: ['continuous'] },
      { exposureTime: 80, iso: 200 },
    );
    expect(steps).toEqual([
      { feature: 'exposure', constraint: { exposureMode: 'manual', exposureTime: 80, iso: 200 } },
      { feature: 'focus', constraint: { focusMode: 'single-shot' } },
    ]);
    // `manual` without a readable current value would lock to an arbitrary one.
    expect(lockSteps({ exposureMode: ['manual'], exposureTime: {} }, {})).toEqual([]);
    expect(lockSteps({}, {})).toEqual([]);
    expect(lockReport(['exposure'])).toEqual({ exposure: 'locked', focus: 'unavailable', whiteBalance: 'unavailable' });
  });

  it('trusts the settings read back, not the applyConstraints promise, and says what was locked', () => {
    const step = { feature: 'exposure' as const, constraint: { exposureMode: 'manual', exposureTime: 80 } };
    expect(lockHeld(step, { exposureMode: 'manual', exposureTime: 79.5 })).toBe(true);
    expect(lockHeld(step, { exposureMode: 'continuous' })).toBe(false);
    expect(lockNoticeKeys(lockReport(['focus']))).toEqual(['contribute.guided.lock.noExposure', 'contribute.guided.lock.focus']);
  });
});

describe('guided capture copy', () => {
  it('has every step, pace, warning and lock string in English and Spanish', () => {
    const keys = [
      ...GUIDED_STEPS.map(stepMessageKey),
      ...(['short', 'onTarget', 'long', 'finish'] as const).map((pace) => `contribute.guided.pace.${pace}`),
      ...(['blur', 'exposure', 'dark', 'portrait'] as const).map((warning) => `contribute.guided.warn.${warning}`),
      ...lockNoticeKeys(lockReport([])), ...lockNoticeKeys(lockReport(['exposure', 'focus'])),
    ];
    for (const key of keys) {
      expect({ key, en: typeof STREET3D_EN[key] }).toEqual({ key, en: 'string' });
      expect({ key, es: typeof STREET3D_ES[key] }).toEqual({ key, es: 'string' });
    }
  });
});
