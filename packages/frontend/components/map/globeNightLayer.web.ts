/**
 * Day and night on the globe: a MapLibre custom layer that multiplies the
 * basemap by the light of the real sun for an instant (the live clock, or the
 * time-of-day scrubber's). The model and the shader are
 * `lib/map/style/globeNight.ts`; the design note is `docs/MAP_TERRAIN_GLOBE.md`
 * → "Day and night".
 *
 * Part of the relief chunk (`reliefLayer.web.ts` adds it with the globe), and
 * like it keeps to "only `MapCanvas.web.tsx` imports a map engine": the
 * `maplibre-gl` import is TYPE-ONLY. Raw WebGL2, one full-screen triangle, no
 * three.js: the relief chunk stays small.
 *
 * Cost: one pass of a ray–sphere test per pixel at globe zooms, nothing from
 * z13 (it has faded out by then) — the quality profile's `relief.globeNight`.
 * It moves by itself only with the live clock, a repaint a minute.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';

import type { MapAppearance } from '@/lib/map/provider';
import {
  GLOBE_NIGHT_FRAGMENT_SHADER,
  GLOBE_NIGHT_LIGHT,
  GLOBE_NIGHT_VERTEX_SHADER,
  globeNightOpacity,
  globeVector,
} from '@/lib/map/style/globeNight';
import { subsolarPoint } from '@/lib/map/sun';

export const GLOBE_NIGHT_LAYER_ID = 'goway:globe-night';

/** How often the live clock's terminator is redrawn while nothing else asks, ms (it moves 0.25° a minute). */
const LIVE_REPAINT_MS = 60_000;

export interface GlobeNightLayer extends CustomLayerInterface {
  /** The instant to light the globe for; `null` follows the live clock. */
  setTime(at: Date | null): void;
  /** Draw or not (the quality profile's `relief.globeNight`). */
  setEnabled(enabled: boolean): void;
}

/** Inverse of a column-major 4×4, in float64; `null` when singular. */
export function invert4(m: ArrayLike<number>): Float32Array | null {
  const a = Array.from({ length: 16 }, (_, i) => m[i]);
  const inv = new Array<number>(16);
  inv[0] =
    a[5] * a[10] * a[15] -
    a[5] * a[11] * a[14] -
    a[9] * a[6] * a[15] +
    a[9] * a[7] * a[14] +
    a[13] * a[6] * a[11] -
    a[13] * a[7] * a[10];
  inv[4] =
    -a[4] * a[10] * a[15] +
    a[4] * a[11] * a[14] +
    a[8] * a[6] * a[15] -
    a[8] * a[7] * a[14] -
    a[12] * a[6] * a[11] +
    a[12] * a[7] * a[10];
  inv[8] =
    a[4] * a[9] * a[15] -
    a[4] * a[11] * a[13] -
    a[8] * a[5] * a[15] +
    a[8] * a[7] * a[13] +
    a[12] * a[5] * a[11] -
    a[12] * a[7] * a[9];
  inv[12] =
    -a[4] * a[9] * a[14] +
    a[4] * a[10] * a[13] +
    a[8] * a[5] * a[14] -
    a[8] * a[6] * a[13] -
    a[12] * a[5] * a[10] +
    a[12] * a[6] * a[9];
  inv[1] =
    -a[1] * a[10] * a[15] +
    a[1] * a[11] * a[14] +
    a[9] * a[2] * a[15] -
    a[9] * a[3] * a[14] -
    a[13] * a[2] * a[11] +
    a[13] * a[3] * a[10];
  inv[5] =
    a[0] * a[10] * a[15] -
    a[0] * a[11] * a[14] -
    a[8] * a[2] * a[15] +
    a[8] * a[3] * a[14] +
    a[12] * a[2] * a[11] -
    a[12] * a[3] * a[10];
  inv[9] =
    -a[0] * a[9] * a[15] +
    a[0] * a[11] * a[13] +
    a[8] * a[1] * a[15] -
    a[8] * a[3] * a[13] -
    a[12] * a[1] * a[11] +
    a[12] * a[3] * a[9];
  inv[13] =
    a[0] * a[9] * a[14] -
    a[0] * a[10] * a[13] -
    a[8] * a[1] * a[14] +
    a[8] * a[2] * a[13] +
    a[12] * a[1] * a[10] -
    a[12] * a[2] * a[9];
  inv[2] =
    a[1] * a[6] * a[15] -
    a[1] * a[7] * a[14] -
    a[5] * a[2] * a[15] +
    a[5] * a[3] * a[14] +
    a[13] * a[2] * a[7] -
    a[13] * a[3] * a[6];
  inv[6] =
    -a[0] * a[6] * a[15] +
    a[0] * a[7] * a[14] +
    a[4] * a[2] * a[15] -
    a[4] * a[3] * a[14] -
    a[12] * a[2] * a[7] +
    a[12] * a[3] * a[6];
  inv[10] =
    a[0] * a[5] * a[15] -
    a[0] * a[7] * a[13] -
    a[4] * a[1] * a[15] +
    a[4] * a[3] * a[13] +
    a[12] * a[1] * a[7] -
    a[12] * a[3] * a[5];
  inv[14] =
    -a[0] * a[5] * a[14] +
    a[0] * a[6] * a[13] +
    a[4] * a[1] * a[14] -
    a[4] * a[2] * a[13] -
    a[12] * a[1] * a[6] +
    a[12] * a[2] * a[5];
  inv[3] =
    -a[1] * a[6] * a[11] +
    a[1] * a[7] * a[10] +
    a[5] * a[2] * a[11] -
    a[5] * a[3] * a[10] -
    a[9] * a[2] * a[7] +
    a[9] * a[3] * a[6];
  inv[7] =
    a[0] * a[6] * a[11] -
    a[0] * a[7] * a[10] -
    a[4] * a[2] * a[11] +
    a[4] * a[3] * a[10] +
    a[8] * a[2] * a[7] -
    a[8] * a[3] * a[6];
  inv[11] =
    -a[0] * a[5] * a[11] +
    a[0] * a[7] * a[9] +
    a[4] * a[1] * a[11] -
    a[4] * a[3] * a[9] -
    a[8] * a[1] * a[7] +
    a[8] * a[3] * a[5];
  inv[15] =
    a[0] * a[5] * a[10] -
    a[0] * a[6] * a[9] -
    a[4] * a[1] * a[10] +
    a[4] * a[2] * a[9] +
    a[8] * a[1] * a[6] -
    a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || det === 0) return null;
  return new Float32Array(inv.map((v) => v / det));
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function createGlobeNightLayer(options: {
  appearance: MapAppearance;
  at: Date | null;
  enabled: boolean;
  /** A defect worth one quiet report (the program did not build). */
  onDefect?: (message: string) => void;
}): GlobeNightLayer {
  let map: MapLibreMap | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let at = options.at;
  let enabled = options.enabled;
  let timer: ReturnType<typeof setInterval> | null = null;
  const night = new Float32Array(
    GLOBE_NIGHT_LIGHT[options.appearance === 'dark' ? 'dark' : 'light'],
  );

  const repaint = () => map?.triggerRepaint();
  const syncTimer = () => {
    const live = map !== null && enabled && at === null;
    if (live && !timer) timer = setInterval(repaint, LIVE_REPAINT_MS);
    if (!live && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    id: GLOBE_NIGHT_LAYER_ID,
    type: 'custom',
    renderingMode: '2d',

    onAdd(added, gl) {
      map = added;
      const vs = compile(gl, gl.VERTEX_SHADER, GLOBE_NIGHT_VERTEX_SHADER);
      const fs = compile(gl, gl.FRAGMENT_SHADER, GLOBE_NIGHT_FRAGMENT_SHADER);
      const linked = vs && fs ? gl.createProgram() : null;
      if (linked && vs && fs) {
        gl.attachShader(linked, vs);
        gl.attachShader(linked, fs);
        gl.linkProgram(linked);
        if (gl.getProgramParameter(linked, gl.LINK_STATUS)) program = linked;
        else gl.deleteProgram(linked);
      }
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (!program) {
        options.onDefect?.('globe night: the shader did not build; the globe stays lit.');
        return;
      }
      vao = gl.createVertexArray();
      for (const name of [
        'uInvGlobe',
        'uInvMercator',
        'uGlobeness',
        'uSun',
        'uNight',
        'uOpacity',
      ]) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      syncTimer();
    },

    onRemove(_removed, gl) {
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      program = null;
      vao = null;
      uniforms = {};
      map = null;
      syncTimer();
    },

    render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      if (!enabled || !program || !vao || !map) return;
      const opacity = globeNightOpacity(map.getZoom());
      if (opacity <= 0) return;
      const data = args.defaultProjectionData;
      const invMercator = invert4(data.fallbackMatrix);
      const invGlobe = data.projectionTransition > 0 ? invert4(data.mainMatrix) : invMercator;
      if (!invMercator || !invGlobe) return;
      const sun = subsolarPoint(at ?? new Date());

      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(uniforms.uInvGlobe, false, invGlobe);
      gl.uniformMatrix4fv(uniforms.uInvMercator, false, invMercator);
      gl.uniform1f(uniforms.uGlobeness, data.projectionTransition);
      gl.uniform3fv(uniforms.uSun, globeVector(sun.lat, sun.lng));
      gl.uniform3fv(uniforms.uNight, night);
      gl.uniform1f(uniforms.uOpacity, opacity);
      // A multiply that keeps the canvas's alpha: dst.rgb × src.rgb.
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },

    setTime(next) {
      at = next;
      syncTimer();
      repaint();
    },

    setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      syncTimer();
      repaint();
    },
  };
}
