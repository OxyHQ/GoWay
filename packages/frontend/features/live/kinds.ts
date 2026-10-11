/**
 * How each kind of live thing is drawn: a glyph shape and a data colour, plus
 * the order the toggles appear in.
 *
 * Data colours, not brand colours: they tell kinds apart on the map and in the
 * legend, the way a transit map colours its lines. Bloom's brand tokens are
 * deliberately not used — a "primary" aircraft would read as a GoWay control.
 * The same hex is passed to the canvas (`MapLiveLayer.glyphs`) and painted on
 * the legend chips, so the two cannot disagree.
 */

import type { LiveEntity, LiveKind } from '@goway.to/sdk/live';

import type { MapLiveGlyph } from '@/components/map';

export const LIVE_KIND_ORDER: readonly LiveKind[] = ['aircraft', 'transit', 'bikeshare', 'vessel'];

export const LIVE_KIND_COLORS: Readonly<Record<LiveKind, string>> = {
  aircraft: '#7c3aed',
  transit: '#dc2626',
  bikeshare: '#4d7c0f',
  vessel: '#0369a1',
};

const TRANSIT_MODE_COLORS: Readonly<Record<string, string>> = {
  bus: '#dc2626',
  tram: '#ea580c',
  subway: '#be185d',
  rail: '#0f766e',
  ferry: '#0369a1',
  cable: '#a16207',
  other: '#57534e',
};

/** Every glyph the live layer may ask the canvas for. */
export const LIVE_GLYPHS: Readonly<Record<string, MapLiveGlyph>> = {
  aircraft: { shape: 'aircraft', color: LIVE_KIND_COLORS.aircraft },
  'aircraft-ground': { shape: 'aircraft', color: '#78716c' },
  bikeshare: { shape: 'station', color: LIVE_KIND_COLORS.bikeshare },
  'bikeshare-empty': { shape: 'station', color: '#a8a29e' },
  vessel: { shape: 'boat', color: LIVE_KIND_COLORS.vessel },
  // Trains and buses: a to-scale silhouette in the line's colour (`tint`).
  train: { shape: 'train', color: TRANSIT_MODE_COLORS.rail as string },
  bus: { shape: 'bus', color: TRANSIT_MODE_COLORS.bus as string },
  ...Object.fromEntries(
    Object.entries(TRANSIT_MODE_COLORS).map(([mode, color]) => [
      `transit-${mode}`,
      { shape: 'vehicle', color } satisfies MapLiveGlyph,
    ]),
  ),
};

export function glyphOf(entity: LiveEntity): string {
  switch (entity.kind) {
    case 'aircraft':
      return entity.onGround ? 'aircraft-ground' : 'aircraft';
    case 'transit':
      return entity.mode === 'bus' ? 'bus' : 'train';
    case 'bikeshare':
      return entity.renting && entity.bikesAvailable > 0 ? 'bikeshare' : 'bikeshare-empty';
    case 'vessel':
      return 'vessel';
  }
}

/** The short text beside a glyph: a line, a bike count; nothing for aircraft and ships. */
/** The colour a transit glyph is drawn in: its line's, else its mode's. */
export function tintOf(entity: LiveEntity): string | undefined {
  if (entity.kind !== 'transit') return undefined;
  return entity.lineColor ?? TRANSIT_MODE_COLORS[entity.mode];
}

export function labelOf(entity: LiveEntity): string | undefined {
  switch (entity.kind) {
    case 'transit':
      return entity.line ?? undefined;
    case 'bikeshare':
      return String(entity.bikesAvailable);
    default:
      return undefined;
  }
}
