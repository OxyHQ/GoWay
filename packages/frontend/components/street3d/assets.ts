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
  /** Loaded first, always. The light splat, or the full one when no preview exists and the tier allows it. */
  first: StreetSceneAsset | null;
  /** Streamed in after `first`, when the tier allows it and it is a different asset. */
  then: StreetSceneAsset | null;
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
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
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

export function planSceneAssets(
  manifest: Pick<StreetSceneManifest, 'assets'>,
  tier: SceneDeviceTier,
  policy: AssetPolicy,
): SceneAssetPlan {
  const find = (role: StreetSceneAsset['role']) =>
    manifest.assets.find((asset) => asset.role === role && isAllowedAssetUrl(asset.url, policy)) ?? null;
  const preview = find('splat_preview');
  const full = find('splat');
  const poster = find('poster');

  if (tier === 'unsupported') return { first: null, then: null, poster };
  if (tier === 'preview') {
    // A device that cannot hold the full splat gets the preview — or nothing,
    // rather than the full splat it was just judged unable to hold.
    return { first: preview, then: null, poster };
  }
  const first = preview ?? full;
  const then = full && first && full.url !== first.url ? full : null;
  return { first, then, poster };
}
