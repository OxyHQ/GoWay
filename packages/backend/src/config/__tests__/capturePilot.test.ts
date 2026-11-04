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
    const config = parseCaptureConfig({
      ...store,
      CAPTURE_PILOT_OXY_USER_IDS: ' user-a , user-b ,',
    });
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
    expect(() =>
      parseCaptureConfig({ ...store, CAPTURE_PILOT_OXY_USER_IDS: 'user a;drop' }),
    ).toThrow();
  });
});

describe('policy', () => {
  test('360° media has its own ceilings', () => {
    const config = parseCaptureConfig(store);
    expect(config.maxEquirectangularPhotoBytes).toBeGreaterThan(config.maxPhotoBytes);
    expect(config.maxEquirectangularVideoWidthPixels).toBe(7680);
  });

  test('is code, not configuration: retired variables a task definition may carry are ignored', () => {
    const retired = parseCaptureConfig({
      ...store,
      CAPTURE_EQUIRECTANGULAR_ENABLED: 'false',
      CAPTURE_MAX_EQUIRECTANGULAR_VIDEO_DURATION_SECONDS: '90',
      CAPTURE_RETENTION_DAYS_RAW_PHOTO: '400',
      CAPTURE_S3_KEY_PREFIX: 'elsewhere',
    });
    expect(retired).toEqual(parseCaptureConfig(store));
    expect(retired.retentionDays.raw_photo).toBe(90);
    expect(retired.keyPrefix).toBe('captures');
  });
});
