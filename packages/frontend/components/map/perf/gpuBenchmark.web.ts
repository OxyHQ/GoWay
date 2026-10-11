/**
 * The warm-up micro-benchmark behind the GPU tier (`lib/map/quality/gpuTier.ts`):
 * how many megapixels a millisecond this GPU fills with a fragment load shaped
 * like the map's heaviest pass — the sky's ground pass with soft shadows: a
 * dozen texture taps and some arithmetic per pixel.
 *
 * Run once per device (the result is stored with the map's preferences), in
 * its own small WebGL2 context on a detached canvas, after the map has gone
 * idle, and only when the 3D city is on; ~10–150 ms of GPU. The context is
 * released at the end.
 */

const VERTEX = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform float uSeed;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float angle = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  mat2 spin = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  vec3 sum = vec3(0.0);
  // Twelve taps on a golden-angle spiral: the sky's soft-shadow load, in shape.
  for (int i = 0; i < 12; i++) {
    float r = sqrt((float(i) + 0.5) / 12.0);
    vec2 offset = r * vec2(cos(float(i) * 2.39996), sin(float(i) * 2.39996));
    sum += texture(uTexture, vUv + spin * offset * 0.01 + uSeed).rgb;
  }
  vec3 c = pow(max(sum / 12.0, vec3(1e-4)), vec3(0.4545)) * exp(-length(vUv - 0.5) * uSeed);
  fragColor = vec4(c, 1.0);
}`;

/** Side of the offscreen target: one megapixel per pass. */
const TARGET = 1024;
/** Passes per timed run, and runs (the best is kept: a run can be unlucky, never lucky). */
const PASSES = 6;
const RUNS = 3;
/** One pass slower than this ends the benchmark early (it would take seconds). */
const SLOW_PASS_MS = 20;

export interface GpuBenchmarkResult {
  renderer: string;
  megapixelsPerMs: number;
  /** Wall time of the whole benchmark, ms. */
  tookMs: number;
}

/** The renderer string of a context, or `''` where the browser masks it. */
export function rendererOf(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const value = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return typeof value === 'string' ? value : '';
}

export function runGpuBenchmark(): GpuBenchmarkResult | null {
  if (typeof document === 'undefined') return null;
  const started = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('compile');
      return shader;
    };
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // A noise texture to sample (256², mipmapped like a real map texture).
    const size = 256;
    const texels = new Uint8Array(size * size * 4);
    for (let i = 0; i < texels.length; i++) texels[i] = (i * 2654435761) >>> 24;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    const seed = gl.getUniformLocation(program, 'uSeed');

    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, TARGET, TARGET);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, TARGET, TARGET);
    const pixel = new Uint8Array(4);

    const run = (passes: number) => {
      const t0 = performance.now();
      for (let i = 0; i < passes; i++) {
        gl.uniform1f(seed, i * 0.013 + 0.5);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // Reading a pixel back waits for every pass to finish.
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return performance.now() - t0;
    };
    // Warm-up: the driver compiles for real on first draw.
    run(1);
    // A GPU this slow (a software rasteriser) has answered already: one more
    // pass is the measurement, not six times three.
    const single = run(1);
    if (single > SLOW_PASS_MS) {
      return {
        renderer: rendererOf(gl),
        megapixelsPerMs: (TARGET * TARGET) / 1e6 / single,
        tookMs: performance.now() - started,
      };
    }
    let best = Infinity;
    for (let i = 0; i < RUNS; i++) best = Math.min(best, run(PASSES));
    const megapixels = (PASSES * TARGET * TARGET) / 1e6;
    return {
      renderer: rendererOf(gl),
      megapixelsPerMs: megapixels / Math.max(best, 0.01),
      tookMs: performance.now() - started,
    };
  } catch {
    return null;
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
