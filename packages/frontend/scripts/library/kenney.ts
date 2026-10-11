/**
 * Reads a Kenney kit model (glTF binary, one shared `colormap.png` palette
 * texture) into plain arrays the model library builds from: positions in the
 * glTF frame, one sRGB colour per vertex looked up in the palette, triangles —
 * and, for a skinned character, its animation clips baked to frames.
 *
 * Kenney kits are CC0 (each download's `License.txt`); the build records the
 * kit, its version and where its licence was verified (`build-model-library.ts`).
 *
 * The files are UNTRUSTED input: they are parsed by `@gltf-transform/core`
 * as data, nothing in them is executed, and only positions, indices, UVs,
 * skins and animation samplers are read.
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
  /** Baked clips: per clip, frames of positions in the same vertex order. */
  clips?: { name: string; fps: number; frames: Float32Array[] }[];
}

export interface ReadOptions {
  /** Skip nodes whose name matches (e.g. wheels, for a far level of detail). */
  skipNodes?: RegExp;
  /** Bake these animation clips (skinned characters), `frames` evenly over each loop. */
  clips?: { name: string; frames: number }[];
  /** An unskinned prop drawn with the character (a wheelchair), read from this file. */
  attach?: string;
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

const toMatrix = (m: ArrayLike<number>) => new THREE.Matrix4().fromArray(Array.from(m));

/** Every node's world matrix, from local TRS overrides (an animation frame) or the file's own. */
function worldMatrices(
  doc: Document,
  overrides: Map<Node, THREE.Matrix4>,
): Map<Node, THREE.Matrix4> {
  const out = new Map<Node, THREE.Matrix4>();
  const visit = (node: Node, parent: THREE.Matrix4) => {
    const local = overrides.get(node) ?? toMatrix(node.getMatrix());
    const world = parent.clone().multiply(local);
    out.set(node, world);
    for (const child of node.listChildren()) visit(child, world);
  };
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, new THREE.Matrix4());
  }
  return out;
}

/** The local TRS matrices of animated nodes at time `t` of a clip (linear / step). */
function poseAt(doc: Document, clip: string, t: number): Map<Node, THREE.Matrix4> {
  const animation = doc
    .getRoot()
    .listAnimations()
    .find((a) => a.getName() === clip);
  if (!animation) throw new Error(`no clip "${clip}"`);
  const trs = new Map<Node, { t: THREE.Vector3; r: THREE.Quaternion; s: THREE.Vector3 }>();
  const of = (node: Node) => {
    let entry = trs.get(node);
    if (!entry) {
      entry = {
        t: new THREE.Vector3(...node.getTranslation()),
        r: new THREE.Quaternion(...node.getRotation()),
        s: new THREE.Vector3(...node.getScale()),
      };
      trs.set(node, entry);
    }
    return entry;
  };
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode();
    const sampler = channel.getSampler();
    const input = sampler?.getInput()?.getArray();
    const output = sampler?.getOutput()?.getArray();
    if (!node || !input || !output) continue;
    const path = channel.getTargetPath();
    const width = path === 'rotation' ? 4 : 3;
    let i = 0;
    while (i + 1 < input.length && input[i + 1] <= t) i++;
    const j = Math.min(i + 1, input.length - 1);
    const span = input[j] - input[i];
    const f =
      sampler?.getInterpolation() === 'STEP' || span <= 0
        ? 0
        : Math.max(0, Math.min(1, (t - input[i]) / span));
    const a = Array.from(output.slice(i * width, i * width + width));
    const b = Array.from(output.slice(j * width, j * width + width));
    const entry = of(node);
    if (path === 'rotation') {
      entry.r.set(a[0], a[1], a[2], a[3]).slerp(new THREE.Quaternion(b[0], b[1], b[2], b[3]), f);
    } else if (path === 'translation') {
      entry.t.set(a[0], a[1], a[2]).lerp(new THREE.Vector3(b[0], b[1], b[2]), f);
    } else if (path === 'scale') {
      entry.s.set(a[0], a[1], a[2]).lerp(new THREE.Vector3(b[0], b[1], b[2]), f);
    }
  }
  const out = new Map<Node, THREE.Matrix4>();
  for (const [node, { t: tr, r, s }] of trs) out.set(node, new THREE.Matrix4().compose(tr, r, s));
  return out;
}

/** Positions of every mesh vertex under one pose, skinned where the mesh has a skin. */
function posed(doc: Document, overrides: Map<Node, THREE.Matrix4>, skip?: RegExp): number[] {
  const world = worldMatrices(doc, overrides);
  const out: number[] = [];
  const v = new THREE.Vector3();
  const acc = new THREE.Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || skip?.test(node.getName())) continue;
    const skin = node.getSkin();
    const jointMatrices = skin?.listJoints().map((joint, k) => {
      const ibm = skin.getInverseBindMatrices()?.getElement(k, []) ?? new THREE.Matrix4().toArray();
      return (world.get(joint) ?? new THREE.Matrix4()).clone().multiply(toMatrix(ibm));
    });
    const nodeWorld = world.get(node) ?? new THREE.Matrix4();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const joints = primitive.getAttribute('JOINTS_0');
      const weights = primitive.getAttribute('WEIGHTS_0');
      if (!position) continue;
      for (let i = 0; i < position.getCount(); i++) {
        v.fromArray(position.getElement(i, []));
        if (jointMatrices && joints && weights) {
          const jw = joints.getElement(i, []);
          const ww = weights.getElement(i, []);
          acc.set(0, 0, 0);
          for (let k = 0; k < 4; k++) {
            if (ww[k] === 0) continue;
            acc.add(v.clone().applyMatrix4(jointMatrices[jw[k]]).multiplyScalar(ww[k]));
          }
          out.push(acc.x, acc.y, acc.z);
        } else {
          const p = v.clone().applyMatrix4(nodeWorld);
          out.push(p.x, p.y, p.z);
        }
      }
    }
  }
  return out;
}

/** Read one kit model; see {@link KenneyMesh}. */
export async function readKenney(
  path: string,
  palette: RgbaImage,
  options: ReadOptions = {},
): Promise<KenneyMesh> {
  const doc = await io.read(path);
  const attached = options.attach ? await io.read(options.attach) : null;
  const colours: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const source of attached ? [doc, attached] : [doc]) {
    for (const node of source.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh || options.skipNodes?.test(node.getName())) continue;
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute('POSITION');
        const uv = primitive.getAttribute('TEXCOORD_0');
        if (!position) continue;
        for (let i = 0; i < position.getCount(); i++) {
          const [u = 0, v = 0] = uv ? uv.getElement(i, []) : [];
          colours.push(...paletteColour(palette, u, v));
        }
        const index = primitive.getIndices();
        const count = index ? index.getCount() : position.getCount();
        for (let i = 0; i < count; i++) indices.push(base + (index ? index.getScalar(i) : i));
        base += position.getCount();
      }
    }
  }
  const restOf = (overrides: Map<Node, THREE.Matrix4>) => [
    ...posed(doc, overrides, options.skipNodes),
    ...(attached ? posed(attached, new Map(), options.skipNodes) : []),
  ];
  const result: KenneyMesh = {
    positions: Float32Array.from(restOf(new Map())),
    colors: Float32Array.from(colours),
    indices: Uint32Array.from(indices),
  };
  if (options.clips) {
    result.clips = options.clips.map(({ name, frames }) => {
      const animation = doc
        .getRoot()
        .listAnimations()
        .find((a) => a.getName() === name);
      if (!animation) throw new Error(`${path}: no clip "${name}"`);
      let duration = 0;
      for (const sampler of animation.listSamplers()) {
        duration = Math.max(duration, sampler.getInput()?.getMax([])[0] ?? 0);
      }
      const out: Float32Array[] = [];
      for (let f = 0; f < frames; f++) {
        out.push(Float32Array.from(restOf(poseAt(doc, name, (duration * f) / frames))));
      }
      return { name, fps: frames / Math.max(duration, 1e-3), frames: out };
    });
    // The rest pose is the first frame of the first clip, so a still person stands.
    result.positions = Float32Array.from(result.clips[0].frames[0]);
  }
  return result;
}
