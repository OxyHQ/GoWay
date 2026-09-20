/**
 * Rotate and pitch as two independent gestures, on a renderer that ships them
 * as one.
 *
 * ## The defect this exists to remove
 *
 * `MapInteractionOptions` has carried `rotate` and `pitch` as separate flags
 * since the seam was written, and the native fork wires them to two separate
 * props (`touchRotate`, `touchPitch`). MapLibre GL JS does not: on a desktop,
 * bearing AND pitch both come out of ONE handler, `map.dragRotate` — Ctrl-drag
 * or right-drag, horizontal for bearing, vertical for pitch. Toggling that
 * handler on `rotate` alone therefore made `{ rotate: false, pitch: true }`
 * mean "two-finger pitch on a touchscreen, and no way to tilt on a desktop",
 * while the same options on native meant "pitch works". One options object,
 * two behaviours, and nothing said so.
 *
 * That matters more than a rendering nicety because `MapInteractionOptions` is
 * re-exported through `@goway.to/sdk`: an integrator reads the two flags,
 * passes them, and gets a different map per platform.
 *
 * ## The contract
 *
 * **`rotate` and `pitch` are independent, on every platform.** Each names one
 * camera axis the user may drive, and neither implies the other.
 *
 * ## How it is honoured here
 *
 * `DragRotateHandler` is a facade over two real handlers — `_mouseRotate` and
 * `_mousePitch` (`src/ui/handler/shim/drag_rotate.ts`; its own `enable()` is
 * `_mouseRotate.enable()` plus `_mousePitch.enable()` when `pitchWithRotate` is
 * set, and `disable()` turns both off). Driving those two directly is the only
 * way to get one axis without the other, because the public facade has no
 * arity between "both" and "neither" and `pitchWithRotate` is a construction
 * option that cannot be changed on a live map.
 *
 * They are underscore-prefixed, so this is a documented reach past the public
 * API rather than an accident, and it degrades rather than throws if a future
 * MapLibre stops splitting the two: the fallback enables the facade whenever
 * EITHER axis is wanted, which keeps pitch reachable (the defect) at the cost
 * of a bearing drag that `rotate: false` did not ask for. `setMaxPitch(0)`
 * remains the backstop on the other side, so the fallback can never leak pitch
 * into a map that asked for none.
 */

/** The two halves of MapLibre's desktop drag handler, as far as this file cares. */
interface DragAxisHandler {
  enable(): void;
  disable(): void;
}

/** `map.dragRotate`: the facade, and the two handlers it is a facade over. */
export interface DragRotateLike extends DragAxisHandler {
  _mouseRotate?: DragAxisHandler;
  _mousePitch?: DragAxisHandler;
}

/**
 * Enable exactly the desktop drag axes asked for.
 *
 * @returns `true` when the two axes were set independently, `false` when the
 *          facade fallback was used — exposed so a test can tell the two paths
 *          apart, and so this file is honest about which one ran.
 */
export function applyDragAxes(
  dragRotate: DragRotateLike,
  axes: { rotate: boolean; pitch: boolean },
): boolean {
  const rotateHandler = dragRotate._mouseRotate;
  const pitchHandler = dragRotate._mousePitch;

  if (rotateHandler && pitchHandler) {
    // `disable()` on the facade first: it is the only call that clears an axis
    // the constructor enabled, and the two `enable()`s below then put back
    // exactly what was asked for.
    dragRotate.disable();
    if (axes.rotate) rotateHandler.enable();
    if (axes.pitch) pitchHandler.enable();
    return true;
  }

  if (axes.rotate || axes.pitch) dragRotate.enable();
  else dragRotate.disable();
  return false;
}
