/**
 * The city-life label: every word in every `LABEL_LANGUAGES` language, read
 * by `localizedLabel` with the whole locale, and composed from what is
 * simulated and what is live in view — never presenting simulation as live.
 * And its reporter: the label exists for exactly as long as anything
 * simulated is drawn, which is what the map's credit shows
 * (`lib/map/__tests__/compactCredit.test.ts`).
 */
import { describe, expect, test } from 'bun:test';

import { LABEL_LANGUAGES } from '@goway.to/sdk';

import {
  CITY_LIFE_LABELS,
  type CityLifeLabel,
  cityLifeLabel,
  cityLifeReporter,
} from '../cityLifeLabel';

describe('the city-life label', () => {
  test('every label carries every LABEL_LANGUAGES language, non-empty', () => {
    for (const labels of CITY_LIFE_LABELS) {
      expect(Object.keys(labels).sort()).toEqual([...LABEL_LANGUAGES].sort());
      for (const value of Object.values(labels)) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  test('simulated only, as before real data arrives', () => {
    const { text, detail } = cityLifeLabel(
      { simulated: ['cars', 'buses', 'people'], live: [] },
      'en-US',
    );
    expect(text).toBe('Simulated: cars, buses, and people');
    expect(detail).toMatch(/not live traffic/);
  });

  test('its one word, for the folded credit, says simulated in the reader’s language', () => {
    const content = { simulated: ['cars' as const], live: ['bus' as const] };
    expect(cityLifeLabel(content, 'en-GB').short).toBe('Simulated');
    expect(cityLifeLabel(content, 'ca-ES').short).toBe('Simulat');
    expect(cityLifeLabel(content, 'ja-JP').short).toBe('シミュレーション');
  });

  test('simulated and live side by side, a class on one side only', () => {
    expect(cityLifeLabel({ simulated: ['cars', 'people'], live: ['bus'] }, 'en').text).toBe(
      'Simulated: cars and people · Live: buses',
    );
    expect(cityLifeLabel({ simulated: ['cars', 'people'], live: ['bus'] }, 'es-ES').text).toBe(
      'Simulado: coches y peatones · En directo: autobuses',
    );
    // Whole-locale matching: Catalan reads Catalan, not Spanish.
    expect(cityLifeLabel({ simulated: ['cars'], live: [] }, 'ca-ES').text).toBe('Simulat: cotxes');
    expect(cityLifeLabel({ simulated: ['cars'], live: [] }, 'zh-CN').text).toBe('模拟：汽车');
  });
});

describe('the city-life reporter', () => {
  const record = () => {
    const told: (CityLifeLabel | null)[] = [];
    return { told, reporter: cityLifeReporter((label) => told.push(label), 'en') };
  };

  test('nothing is told before anything simulated is drawn', () => {
    const { told, reporter } = record();
    reporter.setContent({ simulated: ['cars'], live: [] });
    reporter.end();
    expect(told).toEqual([]);
  });

  test('drawn ⇒ labelled; nothing drawn ⇒ no label', () => {
    const { told, reporter } = record();
    reporter.setActive(true);
    expect(told.at(-1)?.text).toBe('Simulated: cars and people');
    expect(told.at(-1)?.short).toBe('Simulated');
    reporter.setActive(false);
    expect(told.at(-1)).toBeNull();
    reporter.setActive(true);
    expect(told.at(-1)?.text).toBe('Simulated: cars and people');
  });

  test('a change in view is told; the same label twice is not', () => {
    const { told, reporter } = record();
    reporter.setActive(true);
    reporter.setContent({ simulated: ['cars', 'people'], live: [] });
    expect(told.length).toBe(1);
    reporter.setContent({ simulated: ['cars', 'people'], live: ['bus'] });
    expect(told.length).toBe(2);
    expect(told.at(-1)?.text).toBe('Simulated: cars and people · Live: buses');
  });

  test('detaching ends the label', () => {
    const { told, reporter } = record();
    reporter.setActive(true);
    reporter.end();
    expect(told.at(-1)).toBeNull();
    reporter.end();
    expect(told.length).toBe(2);
  });
});
