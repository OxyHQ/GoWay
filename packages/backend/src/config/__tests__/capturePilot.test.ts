import { describe, expect, test } from 'bun:test';
import { mayContribute, parseCaptureConfig } from '../capture';

const store = { CAPTURE_S3_BUCKET: 'goway-captures-test', CAPTURE_S3_REGION: 'us-west-2' };

describe('closed contribution pilot', () => {
  test('no list: contribution is open (routes still require sign-in)', () => {
    const config = parseCaptureConfig(store);
    expect(config.pilotOxyUserIds).toEqual([]);
    expect(mayContribute(config, 'user-a')).toBe(true);
    expect(mayContribute(config, undefined)).toBe(true);
  });

  test('a list admits only its members', () => {
    const config = parseCaptureConfig({ ...store, CAPTURE_PILOT_OXY_USER_IDS: ' user-a , user-b ,' });
    expect(config.pilotOxyUserIds).toEqual(['user-a', 'user-b']);
    expect(mayContribute(config, 'user-a')).toBe(true);
    expect(mayContribute(config, 'user-c')).toBe(false);
    expect(mayContribute(config, undefined)).toBe(false);
  });

  test('no store: nobody may contribute, list or not', () => {
    const config = parseCaptureConfig({ CAPTURE_PILOT_OXY_USER_IDS: 'user-a' });
    expect(mayContribute(config, 'user-a')).toBe(false);
  });

  test('refuses an id that is not an id', () => {
    expect(() => parseCaptureConfig({ ...store, CAPTURE_PILOT_OXY_USER_IDS: 'user a;drop' })).toThrow();
  });
});
