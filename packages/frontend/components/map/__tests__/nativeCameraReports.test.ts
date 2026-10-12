/**
 * The native canvas's camera reports (`nativeCameraReports.ts`), driven the
 * way MapLibre Native drives them: region events, and `getViewState()` read
 * asynchronously once the style has loaded. The same rule as the web
 * (`loadedCamera.ts`), and the same answers.
 */
import { describe, expect, test } from 'bun:test';

import {
  cameraReadingOf,
  createNativeCameraReports,
  type NativeRegionChange,
  type NativeViewState,
} from '@/components/map/nativeCameraReports';
import type { MapViewportChange } from '@/components/map/types';

const TOKYO: NativeViewState = {
  center: [139.7671, 35.6812],
  zoom: 16,
  bearing: 0,
  pitch: 45,
  bounds: [139.76, 35.67, 139.78, 35.69],
};

const region = (userInteraction: boolean, view: NativeViewState = TOKYO): NativeRegionChange => ({
  ...view,
  userInteraction,
});

/** A `getViewState()` the test answers when it chooses. */
function pendingViewState() {
  let answer: (view: NativeViewState) => void = () => {};
  const getViewState = () =>
    new Promise<NativeViewState>((resolve) => {
      answer = resolve;
    });
  return { getViewState, answer: (view: NativeViewState) => answer(view) };
}

const settle = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

function reports(withListener = true) {
  const changes: MapViewportChange[] = [];
  const camera = createNativeCameraReports(() =>
    withListener ? (change) => changes.push(change) : undefined,
  );
  return { camera, changes };
}

describe('the native canvas reports the camera a loaded map opened at', () => {
  test('the style load reads getViewState and reports it as a settled programmatic camera', async () => {
    const { camera, changes } = reports();

    camera.loaded(async () => TOKYO);
    await settle();

    expect(changes).toEqual([{ ...cameraReadingOf(TOKYO), source: 'programmatic', isFinal: true }]);
    expect(changes[0]?.bounds).toEqual({ west: 139.76, south: 35.67, east: 139.78, north: 35.69 });
    expect(changes[0]?.viewport.latitude).toBe(35.6812);
  });

  test('once per engine: a style swap under the same engine reports nothing', async () => {
    const { camera, changes } = reports();

    camera.loaded(async () => TOKYO);
    await settle();
    camera.loaded(async () => TOKYO);
    await settle();

    expect(changes).toHaveLength(1);
  });

  test('a move that starts while the camera is being read discards the read', async () => {
    const { camera, changes } = reports();
    const view = pendingViewState();

    camera.loaded(view.getViewState);
    camera.regionWillChange();
    view.answer(TOKYO);
    await settle();
    expect(changes).toEqual([]);

    // That move reports its own settled camera.
    camera.regionDidChange(region(true));
    expect(changes.map((change) => [change.source, change.isFinal])).toEqual([['user', true]]);
  });

  test('a move that settles while the camera is being read discards the read too', async () => {
    const { camera, changes } = reports();
    const view = pendingViewState();

    camera.loaded(view.getViewState);
    camera.regionWillChange();
    camera.regionDidChange(region(false));
    view.answer({ ...TOKYO, center: [0, 0] });
    await settle();

    expect(changes).toHaveLength(1);
    expect(changes[0]?.viewport.latitude).toBe(35.6812);
  });

  test('a camera moving at load is left to its own settle', async () => {
    const { camera, changes } = reports();

    camera.regionWillChange();
    camera.loaded(async () => TOKYO);
    await settle();

    expect(changes).toEqual([]);
  });

  test('a remounted engine (a retry) has new reports: a move the old one never finished does not silence it', async () => {
    const old = reports();
    old.camera.regionWillChange();
    old.camera.loaded(async () => TOKYO);
    await settle();
    expect(old.changes).toEqual([]);

    const remounted = reports();
    remounted.camera.loaded(async () => TOKYO);
    await settle();
    expect(remounted.changes).toHaveLength(1);
  });

  test('an engine that cannot answer reports nothing and throws nothing', async () => {
    const { camera, changes } = reports();

    camera.loaded(() => {
      throw new Error('no engine');
    });
    await settle();

    expect(changes).toEqual([]);
  });

  test('the embed (no onViewportChange) never reads the camera', async () => {
    const { camera, changes } = reports(false);
    let reads = 0;

    camera.loaded(async () => {
      reads += 1;
      return TOKYO;
    });
    camera.regionDidChange(region(true));
    await settle();

    expect(reads).toBe(0);
    expect(changes).toEqual([]);
  });
});

describe('region events', () => {
  test('the engine says who moved the camera', () => {
    const { camera, changes } = reports();

    camera.regionIsChanging(region(true));
    camera.regionDidChange(region(true));
    camera.regionDidChange(region(false));

    expect(changes.map((change) => [change.source, change.isFinal])).toEqual([
      ['user', false],
      ['user', true],
      ['programmatic', true],
    ]);
  });

  test('a transient command’s frame is not settled, and neither is the camera at load', async () => {
    const { camera, changes } = reports();

    camera.commanded(true);
    camera.regionWillChange();
    expect(camera.regionDidChange(region(false))).toBe(false);
    camera.loaded(async () => TOKYO);
    await settle();
    expect(changes.map((change) => change.isFinal)).toEqual([false]);

    camera.commanded(false);
    camera.regionWillChange();
    expect(camera.regionDidChange(region(false))).toBe(true);
    expect(changes.map((change) => change.isFinal)).toEqual([false, true]);
  });
});
