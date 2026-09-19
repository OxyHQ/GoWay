import { useWindowDimensions } from 'react-native';

/**
 * Which structural layout the screen gets.
 *
 * Issue #7 → Responsive interaction model: "Prefer map + side panel/search
 * results layout where there is room, rather than stretching a mobile bottom
 * sheet across desktop." So this is a question about SPACE, not about platform:
 * a tablet in landscape and a browser window get the panel, a phone and a
 * narrow browser window get the sheet, and the logic and components either one
 * renders are the same.
 */
export type LayoutMode = 'sheet' | 'panel';

/** Below this, a side panel would leave too little map to be worth it. */
export const PANEL_BREAKPOINT = 880;

/** The panel's width. Wide enough for a result row, narrow enough to be chrome. */
export const PANEL_WIDTH = 384;

export function useLayoutMode(): LayoutMode {
  const { width } = useWindowDimensions();
  return width >= PANEL_BREAKPOINT ? 'panel' : 'sheet';
}
