/**
 * Choosing which published assets the viewer loads, and refusing ones it
 * should not.
 *
 * Pure: the device tier and the asset-origin policy are inputs, so the whole
 * decision is unit-tested without a browser.
 */
import type { StreetSceneAsset, StreetSceneManifest } from '@goway.to/sdk';

import type { SceneDeviceTier } from './types';

export interface SceneAssetPlan {
  /**
   * Loaded first, always. A `rad` splat (a level-of-detail tree, on every tier
   * that draws); otherwise the light splat, or the full one when no preview
   * exists and the tier allows it.
   */
  first: StreetSceneAsset | null;
  /** Streamed in after an `spz` `first`, when the tier allows it and it is a different asset. */
  upgrade: StreetSceneAsset | null;
  /** The far shell drawn behind the scene (a `rad`), whenever the scene itself is drawn. */
  environment: StreetSceneAsset | null;
  poster: StreetSceneAsset | null;
}

export interface AssetPolicy {
  /** When set, every asset must be on exactly this origin. */
  allowedOrigin: string | null;
  /** Allow `http:` on any host (development builds only). Loopback `http:` is always allowed. */
  allowInsecure: boolean;
}

function originOf(url: string): { protocol: string; host: string; origin: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url.trim());
  if (!match) return null;
  const protocol = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  if (authority.includes('@')) return null;
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0];
  return { protocol, host, origin: `${protocol}://${authority}` };
}

/** Loopback never leaves the machine, so `http:` there is not a downgrade. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedAssetUrl(url: string, policy: AssetPolicy): boolean {
  const parsed = originOf(url);
  if (!parsed) return false;
  const insecureOk = policy.allowInsecure || LOOPBACK.has(parsed.host);
  if (parsed.protocol !== 'https' && !(insecureOk && parsed.protocol === 'http')) return false;
  if (policy.allowedOrigin && parsed.origin !== policy.allowedOrigin.toLowerCase()) return false;
  return true;
}

/**
 * Whether every chunk a RAD header names may be fetched.
 *
 * A chunked RAD names its chunk files relative to the header, and the
 * contract publishes them BESIDE it. So each must resolve into the header's
 * own directory — not above it, not below it, not on another host — and pass
 * the asset policy exactly as the header did. A chunk with no file name lives
 * inside the header's own file.
 */
export function radChunksAllowed(
  headerUrl: string,
  chunks: readonly { filename?: string }[],
  policy: AssetPolicy,
): boolean {
  let header: URL;
  try {
    header = new URL(headerUrl);
  } catch {
    return false;
  }
  const directory = header.pathname.slice(0, header.pathname.lastIndexOf('/') + 1);
  return chunks.every((chunk) => {
    if (chunk.filename === undefined) return true;
    let url: URL;
    try {
      url = new URL(chunk.filename, header);
    } catch {
      return false;
    }
    return (
      url.origin === header.origin &&
      url.pathname.startsWith(directory) &&
      !url.pathname.slice(directory.length).includes('/') &&
      isAllowedAssetUrl(url.href, policy)
    );
  });
}

export function planSceneAssets(
  manifest: Pick<StreetSceneManifest, 'assets'>,
  tier: SceneDeviceTier,
  policy: AssetPolicy,
): SceneAssetPlan {
  const find = (role: StreetSceneAsset['role']) =>
    manifest.assets.find((asset) => asset.role === role && isAllowedAssetUrl(asset.url, policy)) ??
    null;
  const preview = find('splat_preview');
  const full = find('splat');
  const environment = find('splat_environment');
  const poster = find('poster');

  if (tier === 'unsupported') return { first: null, upgrade: null, environment: null, poster };
  if (full?.format === 'rad') {
    // A level-of-detail tree streams its own coarse levels first and holds
    // only what the tier's budget draws, so every tier loads it, and a
    // preview asset has nothing to add.
    return { first: full, upgrade: null, environment, poster };
  }
  if (tier === 'preview') {
    // A device that cannot hold the full splat gets the preview — or nothing,
    // rather than the full splat it was just judged unable to hold.
    return { first: preview, upgrade: null, environment: preview && environment, poster };
  }
  const first = preview ?? full;
  const upgrade = full && first && full.url !== first.url ? full : null;
  return { first, upgrade, environment: first && environment, poster };
}
