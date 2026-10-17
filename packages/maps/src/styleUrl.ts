/**
 * Which style document a map draws.
 *
 * `goway://styles/<id>` is GoWay's name for a published style, as
 * `mapbox://styles/...` is Mapbox's; `@goway.to/sdk` resolves it to its
 * document on goway.to. A GoWay style that follows the light is drawn in the
 * app's theme — day in light mode, night in dark — unless the screen pins a
 * light. Any other URL is used as it is.
 */
import { gowayStyleUrl, styleDocumentUrl, type MapLightPreset } from '@goway.to/sdk/map';

/** The style a `MapView` draws when it is given none: GoWay Standard. */
export const DEFAULT_MAP_STYLE = gowayStyleUrl('standard');

/**
 * The document URL for `mapStyle`, in `lightPreset` or the theme's light.
 * `null` for a `goway://` name that is not a published style — the map
 * reports that as a style failure rather than drawing a different map than
 * the one asked for.
 *
 * Through `@goway.to/sdk/map`, which has no HTTP client and no schema: a map
 * resolving its style must not carry GoWay's whole contract into an app.
 */
export function resolveStyleUrl(
  mapStyle: string,
  lightPreset: MapLightPreset | undefined,
  dark: boolean,
): string | null {
  return styleDocumentUrl(mapStyle, lightPreset ?? (dark ? 'night' : 'day'));
}
