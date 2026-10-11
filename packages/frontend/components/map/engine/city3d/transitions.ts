/**
 * Cross-fades between what a tile slot draws: nothing → a mesh, one level of
 * detail → another, a mesh → nothing. Renderer-free bookkeeping; the engine
 * turns its output into two shader uniforms per mesh.
 *
 * ## Why dithered, not alpha
 *
 * The buildings are opaque and write depth. Fading them with alpha would need
 * sorting and would show the inside of every building half way through. So a
 * fade is a SCREEN-DOOR: each pixel compares a fixed noise value in `[0, 1)`
 * (`DITHER_GLSL`, interleaved gradient noise on the fragment's screen
 * position) with the fade's progress `f`. The incoming mesh keeps the pixels
 * where `noise < f`; the outgoing one keeps exactly the others. The two are
 * complementary at every pixel and every moment, so a level swap never shows
 * a hole where both meshes have a surface and never draws the same surface
 * twice; and the whole swap is {@link FADE_MS} long, so it reads as a quick
 * dissolve instead of a pop.
 *
 * Tested in `__tests__/city3dLod.test.ts`.
 */

/** How long a fade takes. */
export const FADE_MS = 280;

/** One mesh to draw this frame. `out`: keep `noise >= fade` instead of `< fade`. */
export interface FadeDraw<T> {
  value: T;
  fade: number;
  out: boolean;
}

interface Slot<T> {
  /** What the slot is showing (or fading in). */
  shown: T | null;
  shownSince: number;
  /** What it is fading out, until the shown one has fully faded in. */
  leaving: T | null;
  leavingSince: number;
  /** The frame it was last updated in; slots not updated fade out. */
  touched: number;
}

const progress = (now: number, since: number) => Math.max(0, Math.min(1, (now - since) / FADE_MS));

/**
 * Per-key fade state. Call {@link show} for every slot the frame wants, then
 * {@link draws} once; slots that were not shown this frame fade out.
 */
export class Transitions<T> {
  private readonly slots = new Map<string, Slot<T>>();
  private frame = 0;

  /** Start a frame. */
  begin(): void {
    this.frame++;
  }

  /** The slot `key` should now show `value` (`null`: nothing — fade out). */
  show(key: string, value: T | null, now: number): void {
    let slot = this.slots.get(key);
    if (!slot) {
      if (value === null) return;
      slot = { shown: value, shownSince: now, leaving: null, leavingSince: now, touched: 0 };
      this.slots.set(key, slot);
    }
    slot.touched = this.frame;
    this.retarget(slot, value, now);
  }

  private retarget(slot: Slot<T>, value: T | null, now: number): void {
    if (slot.shown === value) return;
    // Whatever was shown starts leaving now; if it was itself still fading
    // in, it leaves from where it got to rather than from fully drawn.
    const shownProgress = slot.shown === null ? 1 : progress(now, slot.shownSince);
    if (slot.shown !== null && shownProgress > 0) {
      slot.leaving = slot.shown;
      slot.leavingSince = now - (1 - shownProgress) * FADE_MS;
    }
    slot.shown = value;
    slot.shownSince = now;
  }

  /**
   * What to draw now. Also ends slots that finished fading out. `active` is
   * whether any fade is still running (the host must keep repainting).
   */
  draws(now: number): { draws: FadeDraw<T>[]; active: boolean } {
    const draws: FadeDraw<T>[] = [];
    let active = false;
    for (const [key, slot] of this.slots) {
      if (slot.touched !== this.frame) this.retarget(slot, null, now);
      const f = progress(now, slot.shownSince);
      if (slot.shown !== null) {
        draws.push({ value: slot.shown, fade: f, out: false });
        if (f < 1) active = true;
      }
      if (slot.leaving !== null) {
        // Complementary to the incoming mesh while there is one; on its own,
        // it dissolves over its own clock.
        const g = slot.shown !== null ? f : progress(now, slot.leavingSince);
        if (g >= 1) {
          slot.leaving = null;
        } else {
          draws.push({ value: slot.leaving, fade: g, out: true });
          active = true;
        }
      }
      if (slot.shown === null && slot.leaving === null) this.slots.delete(key);
    }
    return { draws, active };
  }

  /** What slot `key` shows (or is fading in), if anything. */
  shown(key: string): T | null {
    return this.slots.get(key)?.shown ?? null;
  }

  /** Every value a slot still draws: protected from cache eviction. */
  *inUse(): IterableIterator<T> {
    for (const slot of this.slots.values()) {
      if (slot.shown !== null) yield slot.shown;
      if (slot.leaving !== null) yield slot.leaving;
    }
  }

  /** Forget a value everywhere (it is being freed). */
  drop(value: T): void {
    for (const [key, slot] of this.slots) {
      if (slot.shown === value) slot.shown = null;
      if (slot.leaving === value) slot.leaving = null;
      if (slot.shown === null && slot.leaving === null) this.slots.delete(key);
    }
  }

  clear(): void {
    this.slots.clear();
  }
}

/**
 * The screen-door test, as GLSL: `uFade` is the progress, `uFadeOut` 1 for the
 * outgoing mesh. Interleaved gradient noise (Jimenez 2014) has no visible
 * grid at any fade and costs four multiplies.
 *
 * Compiled in only under `#define DITHER`, which the engine sets on a tile's
 * materials for the 280 ms it is fading and clears after (`setEntryFade`). A
 * fragment shader that MAY `discard` loses the GPU's early depth test — every
 * covered pixel of every building is then shaded even where a nearer one
 * hides it, and tile-based mobile GPUs pay more still — so a settled city must
 * not carry it.
 */
export const DITHER_GLSL = `
#ifdef DITHER
uniform float uFade;
uniform float uFadeOut;

bool ditherDiscard() {
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return (noise < uFade) == (uFadeOut > 0.5);
}
#endif
`;

/** The fragment shader's first statement: drop the pixels a fade does not keep. */
export const DITHER_DISCARD_GLSL = `#ifdef DITHER
  if (ditherDiscard()) discard;
#endif`;
