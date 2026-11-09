import type { CanvasRegion } from '@oxy.so/bloom/canvas';

/** GoWay policy: leave enough of the map visible beside its place browser. */
export const PANEL_BREAKPOINT = 880;
export const PANEL_WIDTH = 384;

/** Physical occlusion inside this canvas; safe area and viewport overlap by MAX. */
export function canvasChromeInsets({
  bounds,
  viewport,
  safeArea,
}: Pick<CanvasRegion, 'bounds' | 'viewport' | 'safeArea'>) {
  return {
    top: Math.max(viewport.y, safeArea.top),
    right: Math.max(bounds.width - viewport.x - viewport.width, safeArea.right),
    bottom: Math.max(bounds.height - viewport.y - viewport.height, safeArea.bottom),
    left: Math.max(viewport.x, safeArea.left),
  };
}

/** Bottom distance excluded by this canvas's visible viewport, not its safe-area padding. */
export function canvasBottomClearance({
  bounds,
  viewport,
}: Pick<CanvasRegion, 'bounds' | 'viewport'>): number {
  return Math.max(0, bounds.height - viewport.y - viewport.height);
}
