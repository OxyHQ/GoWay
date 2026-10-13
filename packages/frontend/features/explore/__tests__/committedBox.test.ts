/**
 * Which box the explore list is about (`committedBox.ts`), fed by the real web
 * camera reports on a fake engine (`components/map/__tests__/fakeCameraEngine.ts`)
 * so the sequences are the ones a loading map produces.
 *
 * `useExplore` itself does not render under Bun (React Native); the last block
 * reads it to pin that its camera handling IS this module, and that the deep
 * link's framing is what releases a held opening camera.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { PROGRAMMATIC } from '@/components/map/cameraReports.web';
import type { MapViewportChange } from '@/components/map/types';
import {
  type CommittedBox,
  createOpeningFraming,
  nextBoxStep,
} from '@/features/explore/committedBox';
import {
  attachToFake,
  type FakeCameraEngine,
  fakeCameraEngine,
} from '@/components/map/__tests__/fakeCameraEngine';

const BARCELONA_Z11 = { lat: 41.3874, lng: 2.1686, zoom: 11, bearing: 0, pitch: 0, span: 0.2 };
const TOKYO_PLACE = { lat: 35.6812, lng: 139.7671, zoom: 16 };

/**
 * `useExplore`'s camera handling, minus React: every report goes through
 * `nextBoxStep` with the real `createOpeningFraming` as the wait, and the deep
 * link's framing goes through `frame` with the engine's own move — which
 * answers, as `MapApi.moveTo` does, whether a move was issued.
 */
function explore(engine: FakeCameraEngine, options: { deepLink: boolean }) {
  const reports = attachToFake(engine);
  const opening = createOpeningFraming(options.deepLink);
  const state = {
    committed: null as CommittedBox | null,
    areaMoved: false,
  };
  let seen = 0;
  const pump = () => {
    for (; seen < reports.changes.length; seen += 1) {
      const change = reports.changes[seen] as MapViewportChange;
      const step = nextBoxStep(state.committed, change, {
        awaitingOpeningFraming: opening.awaiting,
      });
      if (step.kind === 'hold') opening.hold(change);
      if (step.kind === 'commit') {
        state.committed = step.box;
        state.areaMoved = false;
      }
      if (step.kind === 'area') state.areaMoved = step.moved;
    }
  };
  const commitNow = (box: CommittedBox | null) => {
    if (box) state.committed ??= box;
  };
  return {
    state,
    pump,
    opening,
    /**
     * The deep-linked place arrived: frame it (`useExplore`'s effect). `issue`
     * is the engine's move; `engine: false` is a canvas with nothing to move.
     */
    frameDeepLink(how: { engine?: boolean; jump?: boolean } = {}) {
      commitNow(
        opening.frame(() => {
          if (how.engine === false) return false;
          if (how.jump) {
            engine.move(PROGRAMMATIC, TOKYO_PLACE);
            pump();
          } else {
            engine.fire('movestart', PROGRAMMATIC);
          }
          return true;
        }),
      );
      if (how.engine !== false && !how.jump) {
        Object.assign(engine.camera, TOKYO_PLACE);
        engine.fire('moveend', PROGRAMMATIC);
      }
      pump();
    },
    /** The deep-linked place will never come: the held camera is the box. */
    abandonDeepLink() {
      commitNow(opening.abandon());
    },
  };
}

const centreOf = (box: CommittedBox | null) => box?.camera;

describe('the first box is the map’s opening framing', () => {
  test('a map that loads commits the camera it opened at, with no gesture', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: false });

    engine.fire('load');
    screen.pump();

    expect(centreOf(screen.state.committed)).toEqual({ latitude: 41.3874, longitude: 2.1686 });
    expect(screen.state.committed?.bounds.west).toBeCloseTo(1.9686, 9);
    expect(screen.state.areaMoved).toBe(false);
  });

  test('deep link, map first: the load camera is held, and the place’s framing commits', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    engine.fire('load');
    screen.pump();
    expect(screen.state.committed).toBeNull();

    screen.frameDeepLink();
    expect(centreOf(screen.state.committed)).toEqual({ latitude: 35.6812, longitude: 139.7671 });
    expect(screen.state.committed?.zoom).toBe(16);
    expect(screen.state.areaMoved).toBe(false);
  });

  test('deep link, place first: the framing settles after load and commits; the load reports nothing', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    // The place is in hand before the map has loaded: the framing animates
    // through the load.
    screen.opening.frame(() => {
      engine.fire('movestart', PROGRAMMATIC);
      return true;
    });
    engine.fire('load');
    screen.pump();
    expect(screen.state.committed).toBeNull();

    Object.assign(engine.camera, TOKYO_PLACE);
    engine.fire('moveend', PROGRAMMATIC);
    screen.pump();
    expect(centreOf(screen.state.committed)).toEqual({ latitude: 35.6812, longitude: 139.7671 });
  });

  test('deep link framed with a jump (reduced motion): the jump settles inside the move and commits', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    engine.fire('load');
    screen.pump();
    screen.frameDeepLink({ jump: true });

    expect(centreOf(screen.state.committed)).toEqual({ latitude: 35.6812, longitude: 139.7671 });
  });

  test('deep link whose framing could not be issued (no engine to move): the held camera, at once', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    engine.fire('load');
    screen.pump();
    expect(screen.state.committed).toBeNull();

    screen.frameDeepLink({ engine: false });
    expect(centreOf(screen.state.committed)).toEqual({ latitude: 41.3874, longitude: 2.1686 });
    expect(screen.opening.awaiting).toBe(false);
  });

  test('a framing not issued before the map loaded leaves the load camera to commit', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    screen.frameDeepLink({ engine: false });
    expect(screen.state.committed).toBeNull();
    engine.fire('load');
    screen.pump();

    expect(centreOf(screen.state.committed)).toEqual({ latitude: 41.3874, longitude: 2.1686 });
  });

  test('deep link to a place that never comes: the held load camera is the box', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    engine.fire('load');
    screen.pump();
    screen.abandonDeepLink();

    expect(centreOf(screen.state.committed)).toEqual({ latitude: 41.3874, longitude: 2.1686 });
  });

  test('the reader’s own move commits even while a deep link is pending: they chose', () => {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: true });

    engine.fire('load');
    engine.move({ originalEvent: {} }, { lat: 41.5 });
    screen.pump();

    expect(screen.state.committed?.camera.latitude).toBe(41.5);
  });
});

describe('after the first box', () => {
  function opened() {
    const engine = fakeCameraEngine(BARCELONA_Z11);
    const screen = explore(engine, { deepLink: false });
    engine.fire('load');
    screen.pump();
    return { engine, screen };
  }

  test('a container that grows recommits the same framing’s bigger box, and arms nothing', () => {
    const { engine, screen } = opened();
    const before = screen.state.committed?.bounds;

    // MapLibre's ResizeObserver path: same centre and zoom, a bigger box.
    engine.move({}, { span: 0.3 });
    screen.pump();

    expect(screen.state.committed?.bounds).not.toEqual(before);
    expect(screen.state.committed?.bounds.west).toBeCloseTo(1.8686, 9);
    expect(screen.state.areaMoved).toBe(false);
  });

  for (const [what, to] of [
    ['the Settings 2D/3D toggle (a tilt)', { pitch: 60, span: 0.35 }],
    ['a two-finger rotation', { bearing: 45, span: 0.28 }],
  ] as const) {
    test(`${what} about the same centre is not a resize: nothing recommits`, () => {
      const { engine, screen } = opened();
      const before = screen.state.committed;

      engine.move(PROGRAMMATIC, to);
      screen.pump();
      engine.move({ originalEvent: {} }, to);
      screen.pump();

      expect(screen.state.committed).toBe(before);
      expect(screen.state.areaMoved).toBe(false);
    });
  }

  test('reset north from a rotated, tilted box does not recommit either', () => {
    const engine = fakeCameraEngine({ ...BARCELONA_Z11, bearing: 30, pitch: 50, span: 0.3 });
    const screen = explore(engine, { deepLink: false });
    engine.fire('load');
    screen.pump();
    const before = screen.state.committed;

    engine.move(PROGRAMMATIC, { bearing: 0, pitch: 0, span: 0.2 });
    screen.pump();

    expect(screen.state.committed).toBe(before);
  });

  test('a resize while rotated through ±180° is still the same framing', () => {
    const engine = fakeCameraEngine({ ...BARCELONA_Z11, bearing: 180, pitch: 45 });
    const screen = explore(engine, { deepLink: false });
    engine.fire('load');
    screen.pump();

    // MapLibre wraps the heading into (-180, 180]: the same heading, spelled the other way.
    engine.move({}, { bearing: -179.9999999995, span: 0.3 });
    screen.pump();

    expect(screen.state.committed?.bounds.west).toBeCloseTo(1.8686, 9);
  });

  test('a settle that changes nothing changes nothing', () => {
    const { engine, screen } = opened();
    const before = screen.state.committed;

    engine.move({});
    screen.pump();

    expect(screen.state.committed).toBe(before);
  });

  test('an app move (opening a result) never replaces the box or arms the button', () => {
    const { engine, screen } = opened();
    const before = screen.state.committed;

    engine.move(PROGRAMMATIC, { lat: 41.45, lng: 2.25, zoom: 16 });
    screen.pump();

    expect(screen.state.committed).toBe(before);
    expect(screen.state.areaMoved).toBe(false);
  });

  test('the reader’s pan far enough arms "Search this area"; a nudge does not', () => {
    const { engine, screen } = opened();

    engine.move({ originalEvent: {} }, { lat: 41.3884 });
    screen.pump();
    expect(screen.state.areaMoved).toBe(false);

    engine.move({ originalEvent: {} }, { lat: 41.6 });
    screen.pump();
    expect(screen.state.areaMoved).toBe(true);
    expect(screen.state.committed?.camera.latitude).toBe(41.3874);
  });
});

describe('useExplore is this module', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'useExplore.ts'), 'utf8');

  test('every reported camera goes through nextBoxStep, with the opening framing as the wait', () => {
    expect(source).toMatch(
      /nextBoxStep\(committed, change, \{\s*awaitingOpeningFraming: opening\.awaiting,?\s*\}\)/,
    );
    expect(source).toContain("case 'hold':\n          opening.hold(change);");
    expect(source).toContain("case 'commit':\n          setCommitted(step.box);");
    expect(source).toContain(
      'const [opening] = useState(() => createOpeningFraming(Boolean(options.initialPlaceId)));',
    );
  });

  test('the deep link is framed through opening.frame with moveTo’s answer, and an unissued move commits at once', () => {
    const effect = source.slice(source.indexOf('if (!opening.awaiting) return;'));
    expect(effect).toMatch(
      /const unframed = opening\.frame\(\s*\(\) =>\s*mapRef\.current\?\.moveTo\(place\.location, \{ zoom: DETAIL_ZOOM, duration: cameraDuration \}\) \?\?\s*false,?\s*\);/,
    );
    expect(effect).toContain('if (unframed) setCommitted((current) => current ?? unframed);');
  });

  test('a deep link whose place never comes commits the held camera', () => {
    expect(source).toContain(
      'const openingPlaceGone = selectedPlaceId !== options.initialPlaceId || placeQuery.isError;',
    );
    expect(source).toContain('const held = opening.abandon();');
    expect(source).toContain('if (held) setCommitted((current) => current ?? held);');
  });
});
