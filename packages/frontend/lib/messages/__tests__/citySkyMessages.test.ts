/**
 * The time-of-day scrubber's words and its button's name: every
 * `LABEL_LANGUAGES` language, the same placeholders as English, and read with
 * the whole locale (AGENTS.md).
 */
import { describe, expect, test } from 'bun:test';
import { LABEL_LANGUAGES, type Labels, localizedLabel } from '@goway.to/sdk';

import { TIME_OF_DAY_TRIGGER_LABEL } from '@/lib/map/timeOfDayTriggerLabel';
import type { SunPhase } from '@/lib/map/timeOfDay';

import { CITY_SKY_LABELS } from '../citySky';

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

function expectComplete(name: string, labels: Labels) {
  expect(Object.keys(labels).sort(), name).toEqual([...LABEL_LANGUAGES].sort());
  for (const language of LABEL_LANGUAGES) {
    const label = labels[language];
    expect(label.trim().length, `${name}.${language}`).toBeGreaterThan(0);
    expect(label, `${name}.${language}`).toBe(label.trim());
    expect(label, `${name}.${language}`).toBe(label.normalize('NFC'));
    expect(placeholders(label), `${name}.${language}`).toEqual(placeholders(labels.en));
  }
}

describe('time-of-day words', () => {
  test('every word in every LABEL_LANGUAGES language, placeholders intact', () => {
    for (const [key, labels] of Object.entries(CITY_SKY_LABELS)) expectComplete(key, labels);
    expectComplete('trigger', TIME_OF_DAY_TRIGGER_LABEL);
  });

  test('every sun phase the caption can show has a string', () => {
    const phases: SunPhase[] = ['day', 'golden', 'civil', 'nautical', 'night'];
    for (const phase of phases) expect(CITY_SKY_LABELS[`phase.${phase}`]).toBeDefined();
  });

  test('read with the whole locale', () => {
    expect(localizedLabel(CITY_SKY_LABELS.now, 'ca-ES')).toBe('Ara');
    expect(localizedLabel(CITY_SKY_LABELS.now, 'es-MX')).toBe('Ahora');
    expect(localizedLabel(CITY_SKY_LABELS.close, 'pt-BR')).toBe('Fechar e voltar para agora');
    expect(localizedLabel(TIME_OF_DAY_TRIGGER_LABEL, 'zh-CN')).toBe('时刻');
  });
});
