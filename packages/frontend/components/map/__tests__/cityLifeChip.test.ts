/**
 * The city-life label: every word in every `LABEL_LANGUAGES` language, read
 * by `localizedLabel` with the whole locale, and composed from what is
 * simulated and what is live in view — never presenting simulation as live.
 */
import { describe, expect, test } from 'bun:test';

import { LABEL_LANGUAGES } from '@goway.to/sdk';

import { CITY_LIFE_LABELS, cityLifeLabel } from '../cityLifeLabel';

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
