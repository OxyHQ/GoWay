/**
 * Export a tour as a WebM video (web only): the map's frames, recorded by
 * `MediaRecorder` from a canvas stream — WITH the GoWay mark and the data
 * credit drawn into every frame.
 *
 * ## Why the corners are drawn here
 *
 * On screen `MapCanvas` renders `MapBrand` (bottom-left) and
 * `MapAttribution` (bottom-right) as DOM over the GL canvas, and AGENTS.md
 * makes both unconditional: every map GoWay draws carries them. A recording
 * of the GL canvas alone would be a map GoWay drew, without either — the
 * OpenStreetMap/OpenMapTiles credit an ODbL obligation, gone the moment the
 * file leaves the page. So each frame is composited onto a 2D canvas and the
 * mark and the credit are painted INTO it, from the same sources the DOM uses:
 * the logo's geometry (`components/brand/artwork.ts`, through `Path2D`) and
 * the credit text (`resolveMapAttribution`). Unlike the DOM badge, the
 * exported mark never stands down for `BrandedChromeProvider`: a video has no
 * surrounding chrome to carry the logo for it.
 *
 * ## How frames are taken
 *
 * `MapApi.captureFrames` calls back in the same task MapLibre drew the frame
 * in — the one moment a WebGL canvas without a preserved drawing buffer can be
 * read by `drawImage`. Playback runs in real time, so the video is as smooth
 * as the device renders it; a tile still loading is a tile still loading in
 * the video too (play the tour once first to warm the cache).
 */
import { GOWAY_INK, GOWAY_WORDMARK } from '@/components/brand/artwork';
import type { MapApi } from '@/components/map';
import { MAP_BRAND_WIDTH } from '@/components/map';
import { resolveMapAttribution } from '@/lib/map/provider';

export interface CornerColours {
  /** The credit plate (Bloom's card colour). */
  plate: string;
  /** The credit text. */
  text: string;
}

/** Whether this browser can record a canvas to WebM at all. */
export function canExportVideo(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    typeof Path2D !== 'undefined'
  );
}

function pickMimeType(): string | undefined {
  for (const type of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

const logoPaths = new Map<string, Path2D>();
function path(d: string): Path2D {
  let p = logoPaths.get(d);
  if (!p) {
    p = new Path2D(d);
    logoPaths.set(d, p);
  }
  return p;
}

/**
 * Paint the mark (bottom-left) and the credit (bottom-right) onto a frame,
 * at the sizes `MapBrand` and `MapAttribution` use on screen, times `scale`
 * (device pixels per CSS pixel of the export).
 */
export function drawMapCorners(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number,
  colours: CornerColours,
): void {
  const gap = 8 * scale;
  // The mark: the wordmark's own geometry, outlines first, fills over them.
  const [, , vbWidth, vbHeight] = GOWAY_WORDMARK.viewBox.split(' ').map(Number);
  const logoWidth = MAP_BRAND_WIDTH * scale;
  const k = logoWidth / vbWidth;
  ctx.save();
  ctx.translate(gap, height - gap - vbHeight * k);
  ctx.scale(k, k);
  for (const p of GOWAY_WORDMARK.paths) {
    ctx.fillStyle = GOWAY_INK[p.ink];
    ctx.fill(path(p.d));
  }
  ctx.restore();

  // The credit, on a plate, right-aligned.
  const attribution = resolveMapAttribution();
  const text = [attribution.prefix, ...attribution.links.map((l) => l.label)]
    .filter(Boolean)
    .join(' ');
  const fontSize = 11 * scale;
  ctx.save();
  ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const padX = 8 * scale;
  const padY = 3 * scale;
  const textWidth = ctx.measureText(text).width;
  const plateW = textWidth + padX * 2;
  const plateH = fontSize + padY * 2 + 2 * scale;
  const x = width - gap - plateW;
  const y = height - gap - plateH;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = colours.plate;
  ctx.beginPath();
  ctx.roundRect(x, y, plateW, plateH, 8 * scale);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = colours.text;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + plateH / 2);
  ctx.restore();
}

export interface ExportVideoOptions {
  map: MapApi;
  /** Start playback from 0; resolve when it has played to the end. */
  play: () => Promise<void>;
  colours: CornerColours;
  /** Longest edge of the video, device px. */
  maxEdge?: number;
  frameRate?: number;
  /** Cancels the export: it rejects with an `AbortError` and releases everything. */
  signal?: AbortSignal;
}

/**
 * Record one playback as a WebM `Blob`. Rejects where the browser cannot
 * record (`canExportVideo`) or the map cannot hand over frames.
 */
export async function exportVideo(options: ExportVideoOptions): Promise<Blob> {
  const { map } = options;
  if (!canExportVideo() || !map.captureFrames)
    throw new Error('Video export is not available here.');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas.');

  let sized = false;
  let scale = 1;
  const stop = map.captureFrames(({ canvas: source }) => {
    if (!sized) {
      const maxEdge = options.maxEdge ?? 1920;
      const cssWidth = source.clientWidth || source.width;
      const fit = Math.min(1, maxEdge / Math.max(source.width, source.height));
      canvas.width = Math.round((source.width * fit) / 2) * 2;
      canvas.height = Math.round((source.height * fit) / 2) * 2;
      scale = canvas.width / cssWidth;
      sized = true;
    }
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    drawMapCorners(ctx, canvas.width, canvas.height, scale, options.colours);
  });

  // Cancellation (the player closed mid-recording, the screen unmounted): the
  // playback a caller pauses never reaches its end, so without this the
  // export would wait forever with the recorder, the stream and the frame
  // listener all still running (PR #123 review). An abort rejects with an
  // AbortError, and the `finally` below releases all three either way.
  const signal = options.signal;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException('The video export was cancelled.', 'AbortError'));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});
  const orAbort = <T>(work: Promise<T>) => Promise.race([work, aborted]);

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  try {
    // One frame first, so the stream starts with a sized, branded canvas.
    await orAbort(
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    stream = canvas.captureStream(options.frameRate ?? 30);
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 8_000_000,
    });
    const active = recorder;
    const chunks: Blob[] = [];
    active.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      active.onstop = () => resolve();
    });
    active.start(250);
    await orAbort(options.play());
    active.stop();
    await stopped;
    return new Blob(chunks, { type: mimeType ?? 'video/webm' });
  } finally {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    for (const track of stream?.getTracks() ?? []) track.stop();
    stop();
  }
}

/** Offer a blob as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
