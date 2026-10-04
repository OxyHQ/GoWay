/**
 * The GoWay Street 3D viewer contract — provider-neutral by construction.
 *
 * Same rule as `components/map/types.ts`: nothing here names Spark or
 * three.js, and nothing that imports this may. The web fork
 * (`SceneViewer.web.tsx`) loads its engine lazily from `engine/`; the native
 * fork hosts the web viewer in a WebView. Feature code only ever sees these
 * shapes, so replacing the Gaussian renderer — or picking a native one after
 * the benchmarks #14 Phase F asks for — changes no screen.
 *
 * "Scene coordinates" throughout means the coordinates of the published splat
 * as decoded, which is the frame `worldTransform.enuFromScene` is defined on.
 */
import type { StyleProp, ViewStyle } from 'react-native';
import type { StreetSceneManifest } from '@goway/shared-types';

export type Vec3 = [number, number, number];

/**
 * Where the viewer is.
 *
 *  - `loading`  nothing drawable yet; the poster is showing.
 *  - `preview`  the light splat is drawing; full detail may still stream in.
 *  - `full`     the full splat is drawing.
 *  - `error`    the scene could not be loaded or the GPU context was lost.
 *  - `unsupported` this device cannot draw a scene at all (no WebGL2).
 */
export type SceneViewerPhase = 'loading' | 'preview' | 'full' | 'error' | 'unsupported';

/** Orbit around a point, or walk and look from a point. */
export type SceneViewerControlMode = 'orbit' | 'walk';

/**
 * What the device can afford.
 *
 * `preview` caps the viewer at the light splat: a low-memory or slow device
 * gets a scene it can hold rather than one that crashes the tab.
 */
export type SceneDeviceTier = 'full' | 'preview' | 'unsupported';

export interface SceneViewerStats {
  fps: number;
  /** ms from mount to the first splat frame. */
  firstFrameMs: number | null;
  previewLoadMs: number | null;
  fullLoadMs: number | null;
  /** Splat bytes received so far. */
  bytes: number;
  pixelRatio: number;
  tier: SceneDeviceTier;
}

/** A label pinned to a point in the scene and drawn in screen space. */
export interface SceneViewerLabel {
  id: string;
  name: string;
  position: Vec3;
}

export interface SceneViewerProps {
  manifest: StreetSceneManifest;
  labels?: readonly SceneViewerLabel[];
  /** A label was tapped. The id is whatever the label carried (a Place ID). */
  onLabelPress?: (id: string) => void;
  controlMode?: SceneViewerControlMode;
  onPhaseChange?: (phase: SceneViewerPhase) => void;
  /** Roughly once a second while drawing. */
  onStats?: (stats: SceneViewerStats) => void;
  /** Draw the dev performance overlay. */
  showStats?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}
