import type { LandmarkMaterial } from '../glb';
import type { Builder } from '../kit';

/** One procedural landmark: its materials and the code that builds it (`docs/MAP_LANDMARKS.md`). */
export interface LandmarkModel {
  /** The registry id it builds. */
  id: string;
  materials: Readonly<Record<string, LandmarkMaterial>>;
  build(builder: Builder): void;
}
