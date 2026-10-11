/**
 * Reads a Kenney kit model (glTF binary, one shared `colormap.png` palette
 * texture) into plain arrays the model library builds from: positions in the
 * glTF frame, one sRGB colour per vertex looked up in the palette, triangles.
 *
 * Kenney kits are CC0 (each download's `License.txt`); the build records the
 * kit, its version and where its licence was verified (`build-model-library.ts`).
 *
 * The files are UNTRUSTED input: they are parsed by `@gltf-transform/core`
 * as data, nothing in them is executed, and only node transforms, positions,
 * indices and UVs are read.
 */
import { type Document, Logger, type Node, NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';

import { decodePng, type RgbaImage } from '../mapgen/png';

export interface KenneyMesh {
  /** xyz per vertex, metres, glTF frame (+Y up, front +Z). */
  positions: Float32Array;
  /** sRGB 0–1 per vertex, from the palette. */
  colors: Float32Array;
  indices: Uint32Array;
}

export interface ReadOptions {
  /** Read only the mesh nodes whose name passes (all by default). */
  nodes?: (name: string) => boolean;
}

const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR));

export async function readPalette(path: string): Promise<RgbaImage> {
  return decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function paletteColour(palette: RgbaImage, u: number, v: number): [number, number, number] {
  const x = Math.min(palette.width - 1, Math.max(0, Math.floor(u * palette.width)));
  const y = Math.min(palette.height - 1, Math.max(0, Math.floor(v * palette.height)));
  const o = (y * palette.width + x) * 4;
  return [palette.data[o] / 255, palette.data[o + 1] / 255, palette.data[o + 2] / 255];
}

/** Every node's world matrix. */
function worldMatrices(doc: Document): Map<Node, THREE.Matrix4> {
  const out = new Map<Node, THREE.Matrix4>();
  const visit = (node: Node, parent: THREE.Matrix4) => {
    const world = parent
      .clone()
      .multiply(new THREE.Matrix4().fromArray(Array.from(node.getMatrix())));
    out.set(node, world);
    for (const child of node.listChildren()) visit(child, world);
  };
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, new THREE.Matrix4());
  }
  return out;
}

/** The names of a model's mesh nodes (its body, its wheels…). */
export async function meshNodeNames(path: string): Promise<string[]> {
  const doc = await io.read(path);
  return doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh())
    .map((node) => node.getName());
}

/** Read one kit model, or some of its nodes; see {@link KenneyMesh}. */
export async function readKenney(
  path: string,
  palette: RgbaImage,
  options: ReadOptions = {},
): Promise<KenneyMesh> {
  const doc = await io.read(path);
  const world = worldMatrices(doc);
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const v = new THREE.Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (options.nodes && !options.nodes(node.getName())) continue;
    const matrix = world.get(node) ?? new THREE.Matrix4();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const uv = primitive.getAttribute('TEXCOORD_0');
      if (!position) continue;
      const base = positions.length / 3;
      for (let i = 0; i < position.getCount(); i++) {
        v.fromArray(position.getElement(i, [])).applyMatrix4(matrix);
        positions.push(v.x, v.y, v.z);
        const [u = 0, w = 0] = uv ? uv.getElement(i, []) : [];
        colours.push(...paletteColour(palette, u, w));
      }
      const index = primitive.getIndices();
      const count = index ? index.getCount() : position.getCount();
      for (let i = 0; i < count; i++) indices.push(base + (index ? index.getScalar(i) : i));
    }
  }
  return {
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colours),
    indices: Uint32Array.from(indices),
  };
}
