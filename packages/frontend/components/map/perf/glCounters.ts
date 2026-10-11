/**
 * Counts what a WebGL2 context is asked to do: draw calls, triangles,
 * instances, bytes uploaded, render-target passes and program switches per
 * frame, and an estimate of the GPU memory its buffers, textures and
 * renderbuffers hold. The one measuring instrument of `docs/MAP_PERFORMANCE.md`:
 * the in-app HUD (`mapRuntime.web.ts`), the benchmark (`scripts/bench-map.ts`)
 * and the CI budget gate (`components/map/__tests__/frameBudget.test.ts`) all
 * install THIS function, so the three cannot disagree about what a "draw" or a
 * "byte uploaded" is.
 *
 * Self-contained on purpose — no imports, no module state, nothing captured
 * but its arguments: the benchmark injects it into pages it does not build
 * (`Function.prototype.toString`) to measure any commit the same way,
 * `main` included.
 *
 * It wraps the methods of ONE context object (own properties shadowing the
 * prototype's), so nothing else on the page is touched, and the wrapping costs
 * a property lookup and a few additions per call.
 */

export interface GlFrameCounts {
  /** Every draw call: `drawArrays`/`drawElements` and their instanced and range forms. */
  draws: number;
  /** …of which instanced. */
  instancedDraws: number;
  /** Triangles rasterised: indices or vertices / 3 (strips and fans: n − 2), × instances. */
  triangles: number;
  /** Instances drawn by instanced calls. */
  instances: number;
  /** Bytes handed to the GPU: buffer and texture uploads. */
  uploadBytes: number;
  /** `useProgram` calls that changed the program. */
  programSwitches: number;
  /** Binds of an offscreen framebuffer (render-to-texture passes started). */
  offscreenPasses: number;
  /** Draws made while an offscreen framebuffer was bound. */
  offscreenDraws: number;
}

export interface GlCounterState {
  /** The current frame's counts; the caller copies and zeroes them per frame. */
  frame: GlFrameCounts;
  /** The same counts by section, while `section` names one (see `mapRuntime.web.ts`). */
  bySection: Record<string, GlFrameCounts>;
  /** Attribute what is drawn now to this section ('' for none). */
  section: string;
  /** Live bytes held, by kind. Estimates: level 0 plus a third for mipmapped textures. */
  memory: { buffers: number; textures: number; renderbuffers: number };
}

export function createGlCounterState(): GlCounterState {
  const zero = (): GlFrameCounts => ({
    draws: 0,
    instancedDraws: 0,
    triangles: 0,
    instances: 0,
    uploadBytes: 0,
    programSwitches: 0,
    offscreenPasses: 0,
    offscreenDraws: 0,
  });
  return {
    frame: zero(),
    bySection: {},
    section: '',
    memory: { buffers: 0, textures: 0, renderbuffers: 0 },
  };
}

/** Zero a counts record in place. */
export function resetGlFrame(counts: GlFrameCounts): void {
  counts.draws = 0;
  counts.instancedDraws = 0;
  counts.triangles = 0;
  counts.instances = 0;
  counts.uploadBytes = 0;
  counts.programSwitches = 0;
  counts.offscreenPasses = 0;
  counts.offscreenDraws = 0;
}

/**
 * Wrap `gl` so every call it is asked to make is counted into `state`.
 * Idempotent per context. Returns `false` when `gl` was already instrumented.
 */
export function instrumentWebGl2(gl: WebGL2RenderingContext, state: GlCounterState): boolean {
  // Everything below is local to this function: see the header.
  const marked = gl as unknown as { __gowayGlCounted?: boolean };
  if (marked.__gowayGlCounted) return false;
  marked.__gowayGlCounted = true;
  const target = gl as unknown as Record<string, (...args: unknown[]) => unknown>;

  const TRIANGLES = 0x0004;
  const TRIANGLE_STRIP = 0x0005;
  const TRIANGLE_FAN = 0x0006;
  const TEXTURE_2D = 0x0de1;
  const TEXTURE_CUBE_MAP = 0x8513;

  const zero = () => ({
    draws: 0,
    instancedDraws: 0,
    triangles: 0,
    instances: 0,
    uploadBytes: 0,
    programSwitches: 0,
    offscreenPasses: 0,
    offscreenDraws: 0,
  });
  let offscreen = false;
  let program: unknown = null;

  const sectionCounts = () => {
    if (!state.section) return null;
    let counts = state.bySection[state.section];
    if (!counts) {
      counts = zero();
      state.bySection[state.section] = counts;
    }
    return counts;
  };

  const triangles = (mode: number, count: number) =>
    mode === TRIANGLES
      ? Math.floor(count / 3)
      : mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN
        ? Math.max(0, count - 2)
        : 0;

  const countDraw = (mode: number, count: number, instances: number | null) => {
    const tris = triangles(mode, count) * (instances ?? 1);
    for (const counts of [state.frame, sectionCounts()]) {
      if (!counts) continue;
      counts.draws++;
      counts.triangles += tris;
      if (instances !== null) {
        counts.instancedDraws++;
        counts.instances += instances;
      }
      if (offscreen) counts.offscreenDraws++;
    }
  };

  const upload = (bytes: number) => {
    if (!(bytes > 0)) return;
    state.frame.uploadBytes += bytes;
    const counts = sectionCounts();
    if (counts) counts.uploadBytes += bytes;
  };

  const wrap = (name: string, after: (args: unknown[]) => void, before = false) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (this: unknown, ...args: unknown[]) {
      if (before) after(args);
      const result = original.apply(gl, args);
      if (!before) after(args);
      return result;
    };
  };

  // ── Draws ──
  wrap('drawArrays', (a) => countDraw(a[0] as number, a[2] as number, null));
  wrap('drawElements', (a) => countDraw(a[0] as number, a[1] as number, null));
  wrap('drawRangeElements', (a) => countDraw(a[0] as number, a[3] as number, null));
  wrap('drawArraysInstanced', (a) =>
    countDraw(a[0] as number, a[2] as number, Math.max(0, a[3] as number)),
  );
  wrap('drawElementsInstanced', (a) =>
    countDraw(a[0] as number, a[1] as number, Math.max(0, a[4] as number)),
  );

  // ── Programs and passes ──
  wrap(
    'useProgram',
    (a) => {
      if (a[0] === program) return;
      program = a[0];
      state.frame.programSwitches++;
      const counts = sectionCounts();
      if (counts) counts.programSwitches++;
    },
    true,
  );
  wrap('bindFramebuffer', (a) => {
    const next = a[1] !== null && a[1] !== undefined;
    if (next && !offscreen) {
      state.frame.offscreenPasses++;
      const counts = sectionCounts();
      if (counts) counts.offscreenPasses++;
    }
    offscreen = next;
  });

  // ── Memory: what each object holds ──
  const buffers = new WeakMap<object, number>();
  const textures = new WeakMap<object, number>();
  const renderbuffers = new WeakMap<object, number>();
  const mipmapped = new WeakSet<object>();
  const boundBuffer = new Map<number, object | null>();
  const boundTexture = new Map<string, object | null>();
  let unit = 0x84c0; // TEXTURE0
  let boundRenderbuffer: object | null = null;

  wrap('bindBuffer', (a) => boundBuffer.set(a[0] as number, (a[1] as object | null) ?? null));
  wrap('activeTexture', (a) => {
    unit = a[0] as number;
  });
  wrap('bindTexture', (a) => boundTexture.set(`${unit}:${a[0]}`, (a[1] as object | null) ?? null));
  wrap('bindRenderbuffer', (a) => {
    boundRenderbuffer = (a[1] as object | null) ?? null;
  });

  const setHeld = (
    map: WeakMap<object, number>,
    kind: keyof GlCounterState['memory'],
    object: object | null | undefined,
    bytes: number,
  ) => {
    if (!object) return;
    state.memory[kind] += bytes - (map.get(object) ?? 0);
    map.set(object, bytes);
  };
  const release = (
    map: WeakMap<object, number>,
    kind: keyof GlCounterState['memory'],
    object: unknown,
  ) => {
    if (!object || typeof object !== 'object') return;
    state.memory[kind] -= map.get(object) ?? 0;
    map.delete(object);
  };

  const byteLength = (data: unknown): number => {
    if (typeof data === 'number') return data;
    if (data && typeof data === 'object' && 'byteLength' in data) {
      return (data as { byteLength: number }).byteLength;
    }
    return 0;
  };

  wrap('bufferData', (a) => {
    const bytes = byteLength(a[1]);
    // A size alone allocates; data uploads too.
    if (typeof a[1] !== 'number') upload(bytes);
    setHeld(buffers, 'buffers', boundBuffer.get(a[0] as number), bytes);
  });
  wrap('bufferSubData', (a) => {
    const data = a[2];
    const length = typeof a[4] === 'number' && a[4] > 0 ? (a[4] as number) : undefined;
    const per =
      data && typeof data === 'object' && 'BYTES_PER_ELEMENT' in data
        ? (data as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
        : 1;
    upload(length !== undefined ? length * per : byteLength(data));
  });
  wrap('deleteBuffer', (a) => release(buffers, 'buffers', a[0]));

  // Bytes per texel for a sized internal format, else from format × type.
  const sized: Record<number, number> = {
    32856: 4, // RGBA8
    35907: 4, // SRGB8_ALPHA8
    32849: 3, // RGB8
    33321: 1, // R8
    33323: 2, // RG8
    33189: 2, // DEPTH_COMPONENT16
    33190: 4, // DEPTH_COMPONENT24
    36012: 4, // DEPTH_COMPONENT32F
    35056: 4, // DEPTH24_STENCIL8
    36168: 1, // STENCIL_INDEX8
    34842: 8, // RGBA16F
    34836: 16, // RGBA32F
    33325: 2, // R16F
    33326: 4, // R32F
    36194: 2, // RGB565
    32854: 2, // RGBA4
    32855: 2, // RGB5_A1
  };
  const channels: Record<number, number> = {
    6408: 4, // RGBA
    6407: 3, // RGB
    33319: 2, // RG
    6403: 1, // RED
    6406: 1, // ALPHA
    6409: 1, // LUMINANCE
    6410: 2, // LUMINANCE_ALPHA
    6402: 1, // DEPTH_COMPONENT
    34041: 1, // DEPTH_STENCIL
    36249: 4, // RGBA_INTEGER
  };
  const typeBytes: Record<number, number> = {
    5121: 1, // UNSIGNED_BYTE
    5120: 1, // BYTE
    5123: 2, // UNSIGNED_SHORT
    5122: 2, // SHORT
    5125: 4, // UNSIGNED_INT
    5124: 4, // INT
    5126: 4, // FLOAT
    5131: 2, // HALF_FLOAT
    36193: 2, // HALF_FLOAT_OES
  };
  const packed: Record<number, number> = {
    33635: 2, // UNSIGNED_SHORT_5_6_5
    32819: 2, // UNSIGNED_SHORT_4_4_4_4
    32820: 2, // UNSIGNED_SHORT_5_5_5_1
    34042: 4, // UNSIGNED_INT_24_8
    33640: 4, // UNSIGNED_INT_2_10_10_10_REV
  };
  const texelBytes = (internal: number, format: number, type: number) =>
    sized[internal] ?? packed[type] ?? (channels[format] ?? 4) * (typeBytes[type] ?? 1);

  const sourceSize = (source: unknown): [number, number] => {
    const s = source as {
      width?: number;
      height?: number;
      videoWidth?: number;
      videoHeight?: number;
      displayWidth?: number;
      displayHeight?: number;
    } | null;
    if (!s) return [0, 0];
    return [
      s.videoWidth || s.displayWidth || s.width || 0,
      s.videoHeight || s.displayHeight || s.height || 0,
    ];
  };

  const textureFor = (bindTarget: number) => {
    // Cube faces (0x8515…0x851A) live on the cube-map binding.
    const key = bindTarget >= 0x8515 && bindTarget <= 0x851a ? TEXTURE_CUBE_MAP : bindTarget;
    return boundTexture.get(`${unit}:${key}`) ?? null;
  };

  wrap('texImage2D', (a) => {
    // (target, level, internal, w, h, border, format, type, data?) or
    // (target, level, internal, format, type, source).
    const level = a[1] as number;
    let bytes: number;
    if (a.length >= 8 && typeof a[5] === 'number') {
      const [w, h] = [a[3] as number, a[4] as number];
      bytes = w * h * texelBytes(a[2] as number, a[6] as number, a[7] as number);
      upload(a[8] ? bytes : 0);
    } else {
      const [w, h] = sourceSize(a[5]);
      bytes = w * h * texelBytes(a[2] as number, a[3] as number, a[4] as number);
      upload(bytes);
    }
    if (level !== 0) return;
    const texture = textureFor(a[0] as number);
    if (texture && mipmapped.has(texture)) {
      state.memory.textures -= (textures.get(texture) ?? 0) * 0.34;
      mipmapped.delete(texture);
    }
    const faces = (a[0] as number) === TEXTURE_2D ? 1 : 6;
    setHeld(textures, 'textures', texture, bytes * (faces === 6 ? 6 : 1));
  });
  wrap('texSubImage2D', (a) => {
    // (target, level, x, y, w, h, format, type, data) or (target, level, x, y, format, type, source).
    if (a.length >= 9 && typeof a[6] === 'number' && typeof a[4] === 'number') {
      upload((a[4] as number) * (a[5] as number) * texelBytes(0, a[6] as number, a[7] as number));
    } else {
      const [w, h] = sourceSize(a[6]);
      upload(w * h * texelBytes(0, a[4] as number, a[5] as number));
    }
  });
  wrap('texImage3D', (a) => {
    const bytes =
      (a[3] as number) *
      (a[4] as number) *
      (a[5] as number) *
      texelBytes(a[2] as number, a[7] as number, a[8] as number);
    upload(a[9] ? bytes : 0);
    if ((a[1] as number) === 0) setHeld(textures, 'textures', textureFor(a[0] as number), bytes);
  });
  wrap('texStorage2D', (a) => {
    const levels = a[1] as number;
    const bytes = (a[3] as number) * (a[4] as number) * texelBytes(a[2] as number, 0, 0);
    setHeld(textures, 'textures', textureFor(a[0] as number), levels > 1 ? bytes * 1.34 : bytes);
  });
  wrap('texStorage3D', (a) => {
    const bytes =
      (a[3] as number) * (a[4] as number) * (a[5] as number) * texelBytes(a[2] as number, 0, 0);
    setHeld(textures, 'textures', textureFor(a[0] as number), bytes);
  });
  // A mip chain adds a third, once per texture (MapLibre regenerates on every update).
  wrap('generateMipmap', (a) => {
    const texture = textureFor(a[0] as number);
    if (!texture || mipmapped.has(texture)) return;
    mipmapped.add(texture);
    state.memory.textures += (textures.get(texture) ?? 0) * 0.34;
  });
  wrap('deleteTexture', (a) => {
    const texture = a[0];
    if (texture && typeof texture === 'object' && mipmapped.has(texture)) {
      state.memory.textures -= (textures.get(texture) ?? 0) * 0.34;
      mipmapped.delete(texture);
    }
    release(textures, 'textures', texture);
  });
  wrap('renderbufferStorage', (a) =>
    setHeld(
      renderbuffers,
      'renderbuffers',
      boundRenderbuffer,
      (a[2] as number) * (a[3] as number) * texelBytes(a[1] as number, 0, 0),
    ),
  );
  wrap('renderbufferStorageMultisample', (a) =>
    setHeld(
      renderbuffers,
      'renderbuffers',
      boundRenderbuffer,
      Math.max(1, a[1] as number) *
        (a[3] as number) *
        (a[4] as number) *
        texelBytes(a[2] as number, 0, 0),
    ),
  );
  wrap('deleteRenderbuffer', (a) => release(renderbuffers, 'renderbuffers', a[0]));
  return true;
}
