/**
 * Whether the surface around the map is already showing GoWay's brand.
 *
 * ## The problem this solves
 *
 * `MapBrand` puts the logo on every map, with no `enabled` prop and no way for
 * a screen to turn it off — the same reasoning as `MapAttribution`: a mark
 * that must be on every map cannot be something each screen remembers to add.
 *
 * On a surface whose own chrome already carries the GoWay logo (GoWay's own
 * map screen) it is redundant: the badge in the corner is the brand twice on
 * one screen, and the second one is sitting on the cartography.
 *
 * ## Why a context rather than a prop
 *
 * A `brand={false}` prop on `MapView` would hand every screen the ability to
 * remove the mark by writing one word, which is the property `MapBrand` exists
 * to deny. This inverts it: the badge is on by default, and a surface that
 * ALREADY shows the brand declares so, once, where it draws it.
 *
 * The failure modes are what make it safe. Forget the provider and the badge
 * appears — the brand twice on one screen, ugly and immediately visible. Forget
 * it in an embed and nothing happens at all, because an embed has no chrome to
 * mount it from. No arrangement of mistakes produces an UNBRANDED map in
 * somebody else's page, which is the only outcome that actually matters.
 *
 * Not a boolean threaded down as a prop either: between a screen and the
 * `<MapBrand />` inside `MapView` are components with no opinion about
 * branding, and a prop crossing each of them is another chance to drop it.
 */
import { createContext, useContext, type ReactNode } from 'react';

const BrandedChromeContext = createContext(false);

/**
 * Declares that this subtree's chrome already shows the GoWay logo.
 *
 * Only for chrome that really draws the GoWay logo above the map. An embed in
 * somebody else's page never mounts it — that is the case the badge exists for.
 */
export function BrandedChromeProvider({ children }: { children: ReactNode }) {
  return <BrandedChromeContext.Provider value>{children}</BrandedChromeContext.Provider>;
}

/**
 * `true` when something above this component already shows the brand.
 *
 * Defaults to `false`, which is the whole design: a map rendered anywhere that
 * has not said otherwise gets the badge.
 */
export function useBrandedChrome(): boolean {
  return useContext(BrandedChromeContext);
}
