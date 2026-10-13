/**
 * Reading a TSL node graph without a GPU, for the tests that pin what a
 * shader is built FROM: the constants it holds and the uniforms it reads.
 * (What it draws is the visibility gate's: `scripts/check-city3d-visible.ts`.)
 *
 * A `Fn` body is built only when its material compiles, so a graph is read up
 * to the first shader-function call; the tests read the parts built eagerly.
 */
import type { DataTexture, DepthTexture, Node } from 'three/webgpu';
import {
  DataTexture as DataTextureClass,
  DepthTexture as DepthTextureClass,
  Matrix4,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three/webgpu';

import type { SkyUniformRefs } from '@/components/map/engine/city3d/tsl/skyNodes';

interface GraphNode {
  isConstNode?: boolean;
  isUniformNode?: boolean;
  value?: unknown;
  traverse(callback: (node: GraphNode) => void): void;
}

/** Every node reachable from `root`. */
export function nodesOf(root: Node | unknown): GraphNode[] {
  const out: GraphNode[] = [];
  (root as GraphNode).traverse((node) => out.push(node));
  return out;
}

/** Every number a constant in the graph holds (vector constants by component). */
export function constantsOf(root: Node | unknown): number[] {
  const out: number[] = [];
  for (const node of nodesOf(root)) {
    if (!node.isConstNode) continue;
    const value = node.value as unknown;
    if (typeof value === 'number') out.push(value);
    else if (value && typeof value === 'object' && 'toArray' in value) {
      out.push(...(value as { toArray(): number[] }).toArray());
    }
  }
  return out;
}

/** The value every uniform in the graph holds (its live object, or its number). */
export function uniformValuesOf(root: Node | unknown): unknown[] {
  return nodesOf(root)
    .filter((node) => node.isUniformNode)
    .map((node) => node.value);
}

/** The sky's uniforms (`sky.ts`), with a shadow map or none. */
export function skyRefs(shadows: boolean): SkyUniformRefs {
  const lut: DataTexture = new DataTextureClass(
    new Uint8Array(4 * 4),
    2,
    2,
    RGBAFormat,
    UnsignedByteType,
  );
  const depth: DepthTexture | null = shadows ? new DepthTextureClass(4, 4) : null;
  return {
    uSkyLut: { value: lut },
    uSunAzimuth: { value: 0 },
    uShadowMap: { value: depth },
    uShadowStrength: { value: 0 },
    uShadowTexel: { value: new Vector2(0.25, 0.25) },
    uShadowBias: { value: 0 },
    uGroundZ: { value: 0 },
    uCamera: { value: new Vector3() },
    uSunDir: { value: new Vector3(0, 0, 1) },
    uSunColor: { value: new Vector3(1, 1, 1) },
    uSkyAmbient: { value: new Vector3() },
    uGroundBounce: { value: new Vector3() },
    uStreetGlow: { value: new Vector3() },
    uFloodlight: { value: new Vector3(1, 0.64, 0.34) },
    uShadowMatrix: { value: new Matrix4() },
    uMetresPerMercator: { value: 1 },
    uShadowNormalOffset: { value: 1 },
    uNightFactor: { value: 0 },
  };
}
