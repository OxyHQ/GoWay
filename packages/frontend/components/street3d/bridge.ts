/**
 * The message protocol between the web viewer and the native app hosting it in
 * a WebView (`SceneViewer.native.tsx`).
 *
 * The page is GoWay's own, on GoWay's own origin, and the WebView refuses to
 * navigate anywhere else — but a message is still parsed as untrusted input:
 * it crosses a process boundary and ends in `router.push`, so only a known
 * type with a well-formed id gets through.
 */
import type { SceneViewerPhase } from './types';

export const BRIDGE_SOURCE = 'goway-street3d';
const PHASES: readonly SceneViewerPhase[] = ['loading', 'preview', 'full', 'error', 'unsupported'];
const ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;

export type BridgeMessage =
  | { type: 'place'; placeId: string }
  | { type: 'phase'; phase: SceneViewerPhase };

export function encodeBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify({ source: BRIDGE_SOURCE, ...message });
}

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== 'string' || data.length > 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.source !== BRIDGE_SOURCE) return null;
  if (message.type === 'place' && isSafeId(message.placeId))
    return { type: 'place', placeId: message.placeId };
  if (message.type === 'phase' && PHASES.includes(message.phase as SceneViewerPhase)) {
    return { type: 'phase', phase: message.phase as SceneViewerPhase };
  }
  return null;
}

/** The embed URL the native WebView loads. */
export function embedUrl(webOrigin: string, sceneId: string): string {
  return `${webOrigin.replace(/\/+$/, '')}/street3d/${encodeURIComponent(sceneId)}?embed=1`;
}

/** Whether `url` is on exactly `origin` (scheme + host + port). */
export function isOnOrigin(url: string, origin: string): boolean {
  const normalized = origin.replace(/\/+$/, '').toLowerCase();
  const lower = url.toLowerCase();
  return (
    lower === normalized ||
    lower.startsWith(`${normalized}/`) ||
    lower.startsWith(`${normalized}?`) ||
    lower.startsWith(`${normalized}#`)
  );
}

interface NativeHost {
  ReactNativeWebView?: { postMessage: (message: string) => void };
}

/** Post to the hosting native app. `false` when this page is not in one. */
export function postToNative(message: BridgeMessage): boolean {
  const host = (typeof window !== 'undefined' ? window : undefined) as
    | (NativeHost & object)
    | undefined;
  const bridge = host?.ReactNativeWebView;
  if (!bridge || typeof bridge.postMessage !== 'function') return false;
  bridge.postMessage(encodeBridgeMessage(message));
  return true;
}
