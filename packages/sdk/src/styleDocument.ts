/**
 * The document a `goway://styles/<id>` name stands for — the one rule that
 * turns a style's NAME into the URL a renderer loads, shared by
 * `client.links.styleUrl` and `@goway.to/sdk/map` so the two cannot disagree.
 * No transport and no schema here: a map loads it without the HTTP client.
 */
import {
  GOWAY_STYLE_URL_PREFIX,
  isMapLightPreset,
  mapStylePath,
  parseGoWayStyleUrl,
  resolveMapStyle,
  type MapLightPreset,
} from './contract';

/** The web origin canonical links and style documents are built on unless told otherwise. */
export const DEFAULT_GOWAY_WEB_BASE_URL = 'https://goway.to';

/**
 * The URL a renderer loads for `url`.
 *
 * A `goway://styles/<id>` name resolves to its document on `webBaseUrl`, in
 * the name's own `?light=` first, else `light`, else the style's default — and
 * in the nearest light the style is published in. Any other URL is returned as
 * it is. `null` for a `goway://` name that is not a published style, or a
 * `light` that is not a light: drawing a different map than the one asked for
 * would hide the mistake.
 */
export function styleDocumentUrl(
  url: string,
  light?: MapLightPreset,
  webBaseUrl: string = DEFAULT_GOWAY_WEB_BASE_URL,
): string | null {
  if (!url.startsWith(GOWAY_STYLE_URL_PREFIX)) return url;
  const named = parseGoWayStyleUrl(url);
  if (!named) return null;
  if (light !== undefined && !isMapLightPreset(light)) return null;
  return `${webBaseUrl}${mapStylePath(resolveMapStyle(named.style, named.light ?? light))}`;
}
