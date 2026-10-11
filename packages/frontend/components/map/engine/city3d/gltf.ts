/**
 * The one glTF loader setup every 3D model goes through: three's
 * `GLTFLoader` with meshoptimizer's decoder, because `EXT_meshopt_compression`
 * is in the asset profile (`docs/SDK_MAP_MODELS.md`) — the model layer's
 * models (`models.ts`) and the model library (`../vehicles/library.ts`).
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export function createGltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
