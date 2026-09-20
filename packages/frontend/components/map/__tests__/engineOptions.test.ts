/**
 * The third door into the engine: an option that is PRESENT and `undefined`.
 *
 * `nanCoordinates.test.ts` covers the values we refuse — a NaN coordinate, a
 * NaN box, a NaN scalar. This file covers the one we were still handing over
 * happily, because it does not look like a bad value at all: a key we write
 * into an engine's options object when the caller never asked for it.
 *
 * ## What actually crashed goway.to
 *
 * `MapApi.fitBounds` built its options as `{ padding, duration, maxZoom }`,
 * where `maxZoom` is `asFinite(options?.maxZoom)` and is therefore `undefined`
 * whenever the caller did not ask for a cap. MapLibre fills in its own default
 * in `Camera._cameraForBoxAndBearing`:
 *
 * ```
 * options = extend({ padding, offset: [0, 0], maxZoom: this.transform.maxZoom }, options);
 * ```
 *
 * and its `extend` is `for (const k in src) dest[k] = src[k]` — an OWN key wins
 * even when its value is `undefined`. So the engine's maximum was replaced by
 * `undefined`, and the next line is
 *
 * ```
 * const zoom = Math.min(scaleZoom(tr.scale * Math.min(scaleX, scaleY)), options.maxZoom);
 * ```
 *
 * `Math.min(anything, undefined)` is `NaN`. That `NaN` divides into
 * `offsetAtFinalZoom`, reaches the centre the fit unprojects, and
 * `new LngLat(NaN, NaN)` throws — synchronously, inside the `useEffect` that
 * asked for the fit, which is the error boundary and the whole application.
 *
 * Measured in a real browser against the deployed configuration: open a place,
 * press Directions, press "Route from the map instead". The planner frames the
 * route it just received with `fitCoordinates(..., { padding, duration })` and
 * no `maxZoom`, and the map is replaced by "Something went wrong".
 *
 * ## Why the two previous fixes did not catch it
 *
 * Both looked for a bad NUMBER. #37 checked coordinates; #42 added `asFinite`
 * to the scalars and, with it, the comment "Dropping it means the fit uses the
 * engine's own maximum, which is what omitting it has always meant". That is
 * the belief this file exists to make false: dropping a value is not omitting a
 * key, and the engine can only default what is absent.
 *
 * So the tests below are about the SHAPE of the object the seam hands over,
 * not about the values in it, and the last group is a source-level assertion
 * on both renderer forks — because the defect was at the call site, and a test
 * of a helper in isolation is exactly what the last two attempts already were.
 */
import { describe, expect, test } from 'bun:test';
import { LngLat } from 'maplibre-gl';

import { asFinite, optionalScalar, reportMapDefect, runEngineCommand } from '@/components/map/shared';

/**
 * MapLibre's own defaulting, as `Camera._cameraForBoxAndBearing` performs it.
 *
 * `extend(dest, src)` is `for (const k in src) dest[k] = src[k]`, which for the
 * plain objects involved here is `Object.assign` — own enumerable keys, copied
 * whatever their value. The class that runs it (`Camera`) is not exported, and
 * constructing a `Map` needs a DOM and a WebGL context, so this is the merge
 * itself rather than a call into it; everything downstream of it in these
 * tests is the real package.
 */
function engineDefaults(options: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(
    { padding: { top: 0, bottom: 0, right: 0, left: 0 }, offset: [0, 0], maxZoom: 22 },
    options,
  );
}

/** `cameraForBoxAndBearing`'s zoom line, which is where the NaN is minted. */
function engineZoom(fitted: number, resolved: Record<string, unknown>): number {
  return Math.min(fitted, resolved.maxZoom as number);
}

const PADDING = { top: 72, right: 24, bottom: 480, left: 24 };

describe('an option that is present and undefined', () => {
  test('defeats the engine default that an absent one gets', () => {
    // What the seam used to build for a caller that asked for no cap.
    const written = engineDefaults({ padding: PADDING, duration: 500, maxZoom: undefined });
    expect(written.maxZoom).toBeUndefined();

    // What it builds now.
    const omitted = engineDefaults({ padding: PADDING, duration: 500 });
    expect(omitted.maxZoom).toBe(22);
  });

  test('and that turns the fitted zoom into NaN, which is the crash', () => {
    const written = engineDefaults({ padding: PADDING, duration: 500, maxZoom: undefined });
    expect(Number.isNaN(engineZoom(14.2, written))).toBe(true);

    const omitted = engineDefaults({ padding: PADDING, duration: 500 });
    expect(engineZoom(14.2, omitted)).toBe(14.2);
  });

  test('a NaN zoom reaches the centre the fit unprojects, and MapLibre throws', () => {
    // `zoomScale(NaN)` is `2 ** NaN`, so the padding offset is divided by NaN,
    // the centre is NaN on both axes, and the engine refuses it by name. This
    // is the exact sentence the error boundary showed a user.
    const zoom = engineZoom(14.2, engineDefaults({ maxZoom: undefined }));
    const offset = 1 / Math.pow(2, zoom);
    expect(() => new LngLat(offset, offset)).toThrow('Invalid LngLat object: (NaN, NaN)');
  });
});

describe('optionalScalar', () => {
  test('omits the key entirely when the caller did not ask', () => {
    const options = { padding: PADDING, duration: 500, ...optionalScalar('maxZoom', undefined) };
    // `toBeUndefined()` would pass either way: the key has to be ABSENT.
    expect('maxZoom' in options).toBe(false);
    expect(engineDefaults(options).maxZoom).toBe(22);
  });

  test('omits it for every value the engine cannot use, not just `undefined`', () => {
    for (const value of [undefined, null, NaN, Infinity, -Infinity]) {
      expect('maxZoom' in optionalScalar('maxZoom', value as number)).toBe(false);
    }
  });

  test('carries the value through when there is one', () => {
    expect(optionalScalar('maxZoom', 17)).toEqual({ maxZoom: 17 });
    // Native names the same cap `zoom`; the key is the caller's, the rule is not.
    expect(optionalScalar('zoom', 15)).toEqual({ zoom: 15 });
  });

  test('every fit the app actually issues survives the engine default', () => {
    // The four call sites, as they are written today. Only the first two omit
    // the cap. The first is the one that was measured taking goway.to down —
    // it runs in a `useEffect`, so its throw is a commit-phase throw and the
    // error boundary eats the app. The second runs from the canvas' `onReady`,
    // where the same throw would only lose the embed's frame.
    const callers = [
      { name: 'useDirections: frame the route', maxZoom: undefined },
      { name: 'app/frame.tsx: the embed span box', maxZoom: undefined },
      { name: 'useExplore: a geocoder result with an extent', maxZoom: 15 },
      { name: 'useDirections: centre one maneuver', maxZoom: 17 },
    ];
    for (const caller of callers) {
      const options = {
        padding: PADDING,
        duration: 500,
        ...optionalScalar('maxZoom', asFinite(caller.maxZoom)),
      };
      const zoom = engineZoom(14.2, engineDefaults(options));
      expect(Number.isFinite(zoom)).toBe(true);
    }
  });
});

/**
 * The call sites, because that is where the defect was.
 *
 * Two PRs' worth of predicates already sit in `shared.ts` and the crash
 * outlived both, for the plain reason that the bad object was assembled in the
 * fork and never passed through any of them. So this reads the forks.
 */
describe('neither renderer fork names a camera cap as a plain key', () => {
  const forks = ['MapCanvas.web.tsx', 'MapCanvas.native.tsx'];

  test.each(forks)('%s', async (fork) => {
    const source = await Bun.file(new URL(`../${fork}`, import.meta.url)).text();

    // `{ ..., maxZoom }` and `{ ..., zoom: maxZoom }` are the two spellings
    // that shipped. Both write the key unconditionally.
    const written = [...source.matchAll(/,\s*maxZoom\s*[},]|\bzoom:\s*maxZoom\b/g)].map(
      (match) => match[0].trim(),
    );
    expect(written).toEqual([]);
    // And the cap does still reach the engine — through the one helper that
    // knows how to say "nothing".
    expect(source).toContain("optionalScalar('");
  });
});

describe('the backstop', () => {
  test('an engine call that throws costs the call, not the application', () => {
    let reached = false;
    expect(() =>
      runEngineCommand('fitBounds', () => {
        reached = true;
        throw new Error('Invalid LngLat object: (NaN, NaN)');
      }),
    ).not.toThrow();
    expect(reached).toBe(true);
  });

  test('a call that works is not interfered with', () => {
    let ran = 0;
    runEngineCommand('easeTo', () => {
      ran += 1;
    });
    expect(ran).toBe(1);
  });

  test('it says so, once, through the same reporter every other defect uses', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => void warnings.push(String(message));
    try {
      // A key nothing else in the suite has reported, since `reportMapDefect`
      // de-duplicates for the life of the module.
      const key = `test-${Math.random()}`;
      runEngineCommand(key, () => {
        throw new Error('boom');
      });
      runEngineCommand(key, () => {
        throw new Error('boom');
      });
      // `runEngineCommand` reports under `engine:<command>`; the same key from
      // anywhere else is the same defect and stays quiet too.
      reportMapDefect(`engine:${key}`, 'ignored, already reported');
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[goway/map]');
    expect(warnings[0]).toContain('dropped');
  });
});
