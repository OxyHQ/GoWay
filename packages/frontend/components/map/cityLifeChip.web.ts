/**
 * The "Simulated" label: on screen for exactly as long as the city-life
 * simulation draws a single car or person (`docs/MAP_CITY_LIFE.md` → Honesty).
 *
 * Plain DOM, mounted by the city-3D adapter into the map's own container
 * rather than rendered by `MapCanvas`: the adapter is the one place that
 * knows when the simulation draws (`onActiveChange`), so tying the label to
 * that callback — not to a flag a screen could read differently — is what
 * makes "agents visible ⇒ label visible" hold by construction. It sits at the
 * top right under the account button, clear of the top bar's own controls,
 * the mark (bottom-left) and the data credit (bottom-right), and of any bottom
 * sheet that would cover a bottom edge; it is never interactive chrome: no
 * button, nothing to dismiss.
 *
 * Colours are Bloom's tokens, read as `var(--x)`; nothing is restated.
 */
import { matchLanguageTag } from '@goway.to/sdk';

import { deviceLocale } from '@/lib/i18n';

/** The label's copy, per locale. Every locale carries every key (`__tests__/cityLifeChip.test.ts`). */
export const CITY_LIFE_MESSAGES = {
  en: {
    label: 'Simulated traffic',
    detail:
      'Cars and people here are a simulation on the real street network. They are not live traffic and say nothing about real conditions.',
  },
  es: {
    label: 'Tráfico simulado',
    detail:
      'Los coches y las personas son una simulación sobre la red de calles real. No son tráfico en tiempo real ni indican el estado real de las calles.',
  },
} as const;

export function cityLifeMessages(locale: string) {
  const language = matchLanguageTag(Object.keys(CITY_LIFE_MESSAGES), locale) ?? 'en';
  return CITY_LIFE_MESSAGES[language as keyof typeof CITY_LIFE_MESSAGES] ?? CITY_LIFE_MESSAGES.en;
}

export interface CityLifeChip {
  setVisible(visible: boolean): void;
  remove(): void;
}

export function mountCityLifeChip(container: HTMLElement): CityLifeChip {
  const messages = cityLifeMessages(deviceLocale());
  const chip = document.createElement('div');
  chip.setAttribute('role', 'note');
  chip.setAttribute('aria-label', `${messages.label}. ${messages.detail}`);
  chip.title = messages.detail;
  chip.dataset.gowayCityLife = 'simulated';
  chip.textContent = messages.label;
  Object.assign(chip.style, {
    position: 'absolute',
    top: '72px',
    right: '16px',
    zIndex: '2',
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
  container.appendChild(chip);
  return {
    setVisible(visible) {
      chip.style.display = visible ? 'block' : 'none';
    },
    remove() {
      chip.remove();
    },
  };
}
