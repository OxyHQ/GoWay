/**
 * The GoWay Street 3D viewer seam.
 *
 * Feature code imports from HERE and nowhere else — never from `three`, never
 * from `@sparkjsdev/spark`, never from `engine/`. Same rule, same reason as
 * `components/map`: the renderer is a replaceable adapter.
 */
export { SceneViewer } from './SceneViewer';
export { postToNative, parseBridgeMessage, isSafeId } from './bridge';
export type {
  SceneDeviceTier,
  SceneViewerControlMode,
  SceneViewerLabel,
  SceneViewerPhase,
  SceneViewerProps,
  SceneViewerStats,
  Vec3,
} from './types';
