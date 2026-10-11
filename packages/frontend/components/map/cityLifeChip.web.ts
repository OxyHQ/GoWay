/**
 * The "Simulated" label: on screen for exactly as long as the city-life
 * simulation draws a single car or person (`docs/MAP_CITY_LIFE.md` → Honesty).
 *
 * Plain DOM, mounted by the city-3D adapter into the map's own container
 * rather than rendered by `MapCanvas`: the adapter is the one place that
 * knows when the simulation draws (`onActiveChange`), so tying the label to
 * that callback — not to a flag a screen could read differently — is what
 * makes "agents visible ⇒ label visible" hold by construction. It sits at the
 * top right under the account button — inside the screen's top-right stack
 * when the screen offers one (`chipSlot.ts`), so it flows below the layers
 * button and the other chips instead of on top of them — clear of the top bar's own controls,
 * the mark (bottom-left) and the data credit (bottom-right), and of any bottom
 * sheet that would cover a bottom edge; it is never interactive chrome: no
 * button, nothing to dismiss.
 *
 * It names what is simulated and what is live in view — real first
 * (`docs/MAP_CITY_LIFE.md`): "Simulated: cars, people · Live: buses".
 *
 * Colours are Bloom's tokens, read as `var(--x)`; nothing is restated.
 */
import { deviceLocale } from '@/lib/i18n';

import { MAP_CHIP_SLOT_ID } from './chipSlot';
import { type CityLifeLabelContent, cityLifeLabel } from './cityLifeLabel';

export interface CityLifeChip {
  setVisible(visible: boolean): void;
  /** What is simulated and what is live in view (`cityLifeLabel.ts`). */
  setContent(content: CityLifeLabelContent): void;
  remove(): void;
}

export function mountCityLifeChip(container: HTMLElement): CityLifeChip {
  const locale = deviceLocale();
  const chip = document.createElement('div');
  chip.setAttribute('role', 'note');
  chip.dataset.gowayCityLife = 'simulated';
  let shown = '';
  const setContent = (content: CityLifeLabelContent) => {
    const { text, detail } = cityLifeLabel(content, locale);
    if (text === shown) return;
    shown = text;
    chip.textContent = text;
    chip.title = detail;
    chip.setAttribute('aria-label', `${text}. ${detail}`);
  };
  setContent({ simulated: ['cars', 'people'], live: [] });
  // In the screen's stack it flows; with no stack (the embed) it is placed.
  const slot = document.getElementById(MAP_CHIP_SLOT_ID);
  Object.assign(
    chip.style,
    slot
      ? ({ position: 'relative', alignSelf: 'flex-end' } satisfies Partial<CSSStyleDeclaration>)
      : ({
          position: 'absolute',
          top: '72px',
          right: '16px',
          zIndex: '2',
        } satisfies Partial<CSSStyleDeclaration>),
  );
  Object.assign(chip.style, {
    padding: '4px 10px',
    borderRadius: '999px',
    font: '600 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap',
    background: 'var(--color-card)',
    color: 'var(--color-foreground)',
    border: '1px solid var(--color-border)',
    boxShadow: '0 1px 3px rgb(0 0 0 / 0.18)',
    pointerEvents: 'none',
    display: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  (slot ?? container).appendChild(chip);
  return {
    setVisible(visible) {
      chip.style.display = visible ? 'block' : 'none';
    },
    setContent,
    remove() {
      chip.remove();
    },
  };
}
