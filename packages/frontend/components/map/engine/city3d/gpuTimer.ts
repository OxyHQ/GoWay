/**
 * GPU time of a span of draw calls, where the browser exposes
 * `EXT_disjoint_timer_query_webgl2` — development only (the engine creates one
 * only when it publishes stats). It is how a material port is compared with
 * the material it replaces on the same scene (`docs/MAP_NATIVE_3D.md` →
 * Phase 2): CPU time alone cannot tell a cheaper shader from a slower one.
 *
 * Non-blocking: a query's result is read frames later, when the GPU says it
 * is available; a disjoint event (the GPU was interrupted) drops the samples
 * in flight rather than report a wrong number.
 */
export interface GpuTimer {
  /** Start timing this frame's span (ignored while another span is open). */
  begin(): void;
  end(): void;
  /** Smoothed milliseconds per span, `null` until the first result arrives. */
  readonly ms: number | null;
  dispose(): void;
}

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  if (!ext) return null;
  const pending: WebGLQuery[] = [];
  let open: WebGLQuery | null = null;
  let ms: number | null = null;

  const poll = () => {
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const query of pending) gl.deleteQuery(query);
      pending.length = 0;
      return;
    }
    while (pending.length > 0) {
      const query = pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const sample = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      ms = ms === null ? sample : ms * 0.9 + sample * 0.1;
      gl.deleteQuery(query);
      pending.shift();
    }
  };

  return {
    begin() {
      if (open) return;
      poll();
      open = gl.createQuery();
      if (open) gl.beginQuery(ext.TIME_ELAPSED_EXT, open);
    },
    end() {
      if (!open) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(open);
      open = null;
    },
    get ms() {
      return ms;
    },
    dispose() {
      for (const query of pending) gl.deleteQuery(query);
      pending.length = 0;
    },
  };
}
