/**
 * A WebGL 2 context that draws nothing and answers like a real one, so the
 * REAL three.js renderer and the REAL city engine can run under `bun test`
 * with no GPU — and every call they make can be counted by the map's own GL
 * counters (`components/map/perf/glCounters.ts`). The CI budget gate
 * (`frameBudget.test.ts`) is built on it.
 *
 * What it answers: real constants (`webgl2Constants.ts`), every program and
 * shader compiling and linking, every framebuffer complete, generous limits,
 * and NO active uniforms or attributes — so three sets none and binds none,
 * which changes nothing about how many draws, triangles, passes and uploads a
 * frame makes, the only things the gate reads. Every other WebGL 2 method is
 * a no-op, and anything that is not one is `undefined`, as on a real context.
 */
import { WEBGL2_CONSTANTS as GL, WEBGL2_METHODS } from './webgl2Constants';

export interface FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
  addEventListener(): void;
  removeEventListener(): void;
  getContext(): unknown;
}

export function createFakeWebGl2(
  width: number,
  height: number,
): {
  gl: WebGL2RenderingContext;
  canvas: FakeCanvas;
} {
  const canvas: FakeCanvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext: () => gl,
  };
  const parameter = (p: number): unknown => {
    switch (p) {
      case GL.VERSION:
        return 'WebGL 2.0 (fake)';
      case GL.SHADING_LANGUAGE_VERSION:
        return 'WebGL GLSL ES 3.00 (fake)';
      case GL.VENDOR:
      case GL.RENDERER:
        return 'GoWay fake WebGL2';
      case GL.VIEWPORT:
      case GL.SCISSOR_BOX:
        return new Int32Array([0, 0, width, height]);
      case GL.MAX_TEXTURE_SIZE:
      case GL.MAX_CUBE_MAP_TEXTURE_SIZE:
      case GL.MAX_RENDERBUFFER_SIZE:
      case GL.MAX_3D_TEXTURE_SIZE:
        return 16384;
      case GL.MAX_VIEWPORT_DIMS:
        return new Int32Array([16384, 16384]);
      case GL.MAX_SAMPLES:
        return 4;
      case GL.MAX_VERTEX_UNIFORM_VECTORS:
      case GL.MAX_FRAGMENT_UNIFORM_VECTORS:
        return 1024;
      case GL.MAX_VARYING_VECTORS:
        return 30;
      case GL.MAX_TEXTURE_IMAGE_UNITS:
      case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
      case GL.MAX_VERTEX_ATTRIBS:
        return 16;
      case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
        return 32;
      case GL.ALIASED_LINE_WIDTH_RANGE:
      case GL.ALIASED_POINT_SIZE_RANGE:
        return new Float32Array([1, 1]);
      default:
        return 0;
    }
  };
  const object = () => ({});
  const known: Record<string, (...args: unknown[]) => unknown> = {
    getContextAttributes: () => ({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
      desynchronized: false,
    }),
    getExtension: () => null,
    getSupportedExtensions: () => [],
    getParameter: (p) => parameter(p as number),
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createTexture: object,
    createBuffer: object,
    createFramebuffer: object,
    createRenderbuffer: object,
    createProgram: object,
    createShader: object,
    createVertexArray: object,
    createQuery: object,
    createSampler: object,
    createTransformFeedback: object,
    getProgramParameter: (_program, p) =>
      p === GL.LINK_STATUS || p === GL.VALIDATE_STATUS ? true : 0,
    getShaderParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    getShaderSource: () => '',
    getUniformLocation: object,
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => GL.INVALID_INDEX,
    checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
    isContextLost: () => false,
    getError: () => GL.NO_ERROR,
    fenceSync: object,
    clientWaitSync: () => GL.ALREADY_SIGNALED,
  };
  const target: Record<string, unknown> = {
    ...GL,
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
  };
  for (const name of WEBGL2_METHODS) target[name] = known[name] ?? (() => undefined);
  const gl = new Proxy(target, {
    get(t, name) {
      // Anything else — an expando a caller set, or nothing — as on a real context.
      return typeof name === 'string' ? t[name] : undefined;
    },
    set(t, name, value) {
      t[name as string] = value;
      return true;
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, canvas };
}
