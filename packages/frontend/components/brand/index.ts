/**
 * GoWay's brand, as the rest of the app sees it.
 *
 * Feature code imports the component from here and never reaches into
 * `artwork.ts`; the path data is an implementation detail of the drawing, and
 * the day the logo is revised it should change in one file and nowhere else.
 */
export { GowayLogo, gowayLogoHeight } from './GowayLogo';
export { BrandedChromeProvider, useBrandedChrome } from './BrandedChrome';
export type { GowayLogoProps, GowayLogoVariant } from './GowayLogo';
export { GOWAY_INK, GOWAY_MARK, GOWAY_WORDMARK, aspectRatio } from './artwork';
export type { GowayArtwork, GowayInk, GowayPart, GowayPath } from './artwork';
