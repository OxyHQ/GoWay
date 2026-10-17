/**
 * Which style document a map draws.
 *
 * `goway://styles/<id>` is GoWay's name for a published style, as
 * `mapbox://styles/...` is Mapbox's; `@goway.to/sdk` resolves it to its
 * document on goway.to. A GoWay style that follows the light is drawn in the
 * app's theme — day in light mode, night in dark — unless the screen pins a
 * light. Any other URL is used as it is.
 */
import { createGoWayClient, gowayStyleUrl, type MapLightPreset } from '@goway.to/sdk';

/** The style a `MapView` draws when it is given none: GoWay Standard. */
export const DEFAULT_MAP_STYLE = gowayStyleUrl('standard');

const links = createGoWayClient().links;

/**
 * The document URL for `mapStyle`, in `lightPreset` or the theme's light.
 * Throws `GoWayValidationError` for a `goway://` name that is not a published
 * style — the map reports that as a style failure rather than drawing a
 * different map than the one asked for.
 */
export function resolveStyleUrl(
  mapStyle: string,
  lightPreset: MapLightPreset | undefined,
  dark: boolean,
): string {
  return links.styleUrl(mapStyle, lightPreset ?? (dark ? 'night' : 'day'));
}
