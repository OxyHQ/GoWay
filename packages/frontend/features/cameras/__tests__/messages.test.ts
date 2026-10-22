/**
 * The cameras copy: every locale carries every key with the same placeholders,
 * and every status, class, congestion level and health the contract can say
 * has words — so a new value in the contract cannot reach a person as a raw key.
 */
import { describe, expect, test } from 'bun:test';
import { CAMERA_HEALTH, CAMERA_STATUSES, CONGESTION_LEVELS, OBSERVED_CLASSES } from '@goway.to/sdk';

import { CAMERAS_EN, CAMERAS_ES } from '../messages';

const placeholders = (text: string | undefined) => (text?.match(/\{\w+\}/g) ?? []).sort();

describe('camera messages', () => {
  test('every locale carries exactly the same keys and placeholders', () => {
    expect(Object.keys(CAMERAS_ES).sort()).toEqual(Object.keys(CAMERAS_EN).sort());
    for (const [key, english] of Object.entries(CAMERAS_EN)) {
      expect({ key, placeholders: placeholders(CAMERAS_ES[key]) }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  test('no message is empty, and Spanish is not left as English', () => {
    for (const [key, text] of Object.entries(CAMERAS_EN)) {
      expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false });
    }
    const untranslated = Object.keys(CAMERAS_EN).filter(
      (key) => CAMERAS_ES[key] === CAMERAS_EN[key] && !/^\W*$/.test(CAMERAS_EN[key] ?? ''),
    );
    expect(untranslated).toEqual([]);
  });

  test('every value the contract can say has words', () => {
    const keys = [
      ...CAMERA_STATUSES.map((s) => `cameras.status.${s}`),
      ...OBSERVED_CLASSES.map((c) => `cameras.class.${c}`),
      ...CONGESTION_LEVELS.map((c) => `cameras.congestion.${c}`),
      ...CAMERA_HEALTH.filter((h) => h !== 'ok').map((h) => `cameras.health.${h}`),
    ];
    for (const key of keys) expect({ key, has: key in CAMERAS_EN }).toEqual({ key, has: true });
  });
});
