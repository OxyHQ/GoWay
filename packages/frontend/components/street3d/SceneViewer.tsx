/**
 * `SceneViewer` — the shared contract, and the fallback.
 *
 * Metro resolves `SceneViewer.web.tsx` on web and `SceneViewer.native.tsx` on
 * iOS and Android, so this file is normally never bundled. It exists, like
 * `components/map/MapCanvas.tsx`, so that `tsc` (which has no platform
 * extensions) checks every call site against one signature, and so that any
 * other platform gets the product's own "unsupported" state rather than a
 * missing-module crash.
 */
import { memo, useEffect } from 'react';
import { View } from 'react-native';

import type { SceneViewerProps } from './types';

function SceneViewerComponent({ onPhaseChange, style, testID }: SceneViewerProps) {
  useEffect(() => {
    onPhaseChange?.('unsupported');
  }, [onPhaseChange]);
  return <View style={style} testID={testID} className="flex-1" />;
}

export const SceneViewer = memo(SceneViewerComponent);
