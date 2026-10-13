import type { CartographyPalette } from './palette';

/** Drawings for basemap presentation groups, independent of the Places taxonomy. */
export const POI_BADGE_ICONS: Record<keyof CartographyPalette['poi'], string> = {
  foodDrink: 'goway-restaurant',
  shopping: 'goway-shop',
  outdoors: 'goway-park',
  transit: 'goway-transit-station',
  lodging: 'goway-hotel',
  health: 'goway-hospital',
  civic: 'goway-civic',
  culture: 'goway-museum',
  worship: 'goway-place',
  vehicle: 'goway-parking',
  other: 'goway-place',
};
