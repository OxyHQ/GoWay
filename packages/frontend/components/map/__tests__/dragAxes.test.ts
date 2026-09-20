/**
 * `rotate` and `pitch` mean the same thing on both platforms.
 *
 * The regression this pins down: `MapCanvas.web.tsx` used to gate MapLibre's
 * desktop drag handler on `gestures.rotate` alone. That handler is BOTH axes —
 * Ctrl-drag/right-drag, horizontal for bearing and vertical for pitch — so
 * `{ rotate: false, pitch: true }` produced a map that could be tilted with two
 * fingers on a phone and could not be tilted at all with a mouse, while the
 * native fork (a prop per axis) honoured the same options object fully.
 * `MapInteractionOptions` is re-exported by `@goway.to/sdk`, so that was one
 * public contract with two meanings.
 *
 * These run against MapLibre's REAL `DragRotateHandler`, constructed with fake
 * axis handlers rather than through a `Map` (which needs a WebGL context). That
 * is the point: the facade's semantics — `enable()` turns on rotate and, when
 * `pitchWithRotate` is set, pitch; `disable()` turns off all of them — are the
 * thing being worked around, so they have to be the engine's own and not a
 * retelling of them.
 */
import { describe, expect, test } from 'bun:test';
import { DragRotateHandler } from 'maplibre-gl';

import { applyDragAxes, type DragRotateLike } from '@/components/map/dragAxes';

function fakeAxis() {
  const axis = {
    enabled: false,
    enable() {
      axis.enabled = true;
    },
    disable() {
      axis.enabled = false;
    },
    isEnabled: () => axis.enabled,
    isActive: () => false,
  };
  return axis;
}

/**
 * The real facade over three fake axes, wired the way `Map` wires it: MapLibre's
 * defaults are `pitchWithRotate: true` and `rollEnabled: false`, and
 * `MapCanvas.web.tsx` overrides neither.
 */
function realDragRotate() {
  const rotate = fakeAxis();
  const pitch = fakeAxis();
  const roll = fakeAxis();
  const handler = new DragRotateHandler(
    { pitchWithRotate: true, rollEnabled: false },
    rotate as never,
    pitch as never,
    roll as never,
  );
  // The constructor does not enable anything; `Map` does, by calling `enable()`
  // once at startup for every handler its options leave on. Start from there,
  // because "already on and never turned off" is how the defect rendered.
  handler.enable();
  return { handler: handler as unknown as DragRotateLike, rotate, pitch, roll };
}

describe('desktop drag axes', () => {
  test('the engine really does drive both axes from one handler', () => {
    // The premise. If this ever stops being true, the workaround below is
    // unnecessary rather than wrong — and this is the line that says so.
    const { handler, rotate, pitch } = realDragRotate();
    expect([rotate.enabled, pitch.enabled]).toEqual([true, true]);
    handler.disable();
    expect([rotate.enabled, pitch.enabled]).toEqual([false, false]);
    // And it exposes no arity between "both" and "neither".
    expect(typeof (handler as { enableRotation?: unknown }).enableRotation).toBe('undefined');
  });

  test('pitch survives rotate being off — the defect, directly', () => {
    const { handler, rotate, pitch } = realDragRotate();
    expect(applyDragAxes(handler, { rotate: false, pitch: true })).toBe(true);
    // Gating the whole handler on `rotate` left BOTH of these false, which is
    // a desktop with no way to tilt the map at all.
    expect(pitch.enabled).toBe(true);
    expect(rotate.enabled).toBe(false);
  });

  test('rotate without pitch does not smuggle the tilt back in', () => {
    const { handler, rotate, pitch } = realDragRotate();
    applyDragAxes(handler, { rotate: true, pitch: false });
    expect(rotate.enabled).toBe(true);
    expect(pitch.enabled).toBe(false);
  });

  test('both, and neither', () => {
    const on = realDragRotate();
    applyDragAxes(on.handler, { rotate: true, pitch: true });
    expect([on.rotate.enabled, on.pitch.enabled]).toEqual([true, true]);

    // `interactive=0` on /frame passes every flag false, and a handler the map
    // enabled at startup has to be actively turned off for that to hold.
    const off = realDragRotate();
    applyDragAxes(off.handler, { rotate: false, pitch: false });
    expect([off.rotate.enabled, off.pitch.enabled]).toEqual([false, false]);
  });

  test('roll is nobody\'s axis here and stays off', () => {
    // `rollEnabled` is false on the maps this app builds, so the facade never
    // enables it; reaching past the facade must not start.
    const { handler, roll } = realDragRotate();
    applyDragAxes(handler, { rotate: true, pitch: true });
    expect(roll.enabled).toBe(false);
  });

  test('degrades to the public facade if MapLibre stops splitting the two', () => {
    let enabled = true;
    const facade: DragRotateLike = {
      enable() {
        enabled = true;
      },
      disable() {
        enabled = false;
      },
    };
    // `false` is the return value saying the fallback ran, and the fallback's
    // rule is the safe half of the contract: the handler is on whenever EITHER
    // axis is wanted, so pitch is never silently lost. (`setMaxPitch(0)` in the
    // canvas is what stops the reverse leak.)
    expect(applyDragAxes(facade, { rotate: false, pitch: true })).toBe(false);
    expect(enabled).toBe(true);
    applyDragAxes(facade, { rotate: false, pitch: false });
    expect(enabled).toBe(false);
  });
});
