/**
 * The "Simulated traffic" label: every locale carries every key, the locale
 * is matched as a label is (whole tag), and the label is mounted hidden and
 * shown only when the simulation says it draws.
 */
import { describe, expect, test } from 'bun:test';

import { CITY_LIFE_MESSAGES, cityLifeMessages } from '../cityLifeChip.web';

describe('the simulated-traffic label', () => {
  test('every locale carries every key, non-empty', () => {
    const keys = Object.keys(CITY_LIFE_MESSAGES.en).sort();
    for (const messages of Object.values(CITY_LIFE_MESSAGES)) {
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const value of Object.values(messages)) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  test('says it is simulated, in the language asked for', () => {
    expect(cityLifeMessages('en-US').label).toMatch(/simulated/i);
    expect(cityLifeMessages('es-MX').label).toMatch(/simulado/i);
    expect(cityLifeMessages('ca-ES').label).toBe(CITY_LIFE_MESSAGES.en.label);
    for (const messages of Object.values(CITY_LIFE_MESSAGES)) {
      // Never presented as live.
      expect(messages.detail).toMatch(/not live|no son tráfico en tiempo real/i);
    }
  });
});
