import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_ASSET_STATES,
  CAPTURE_PRIVACY_STATES,
  STREET_SCENE_REPORT_REASONS,
} from '@goway.to/sdk';

import { contributionStatus } from '@/features/contribute/status';

import { STREET3D_EN, STREET3D_ES } from '../street3d';

describe('Street 3D messages', () => {
  test('every locale carries exactly the same keys', () => {
    expect(Object.keys(STREET3D_ES).sort()).toEqual(Object.keys(STREET3D_EN).sort());
  });

  test('placeholders match across locales', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(STREET3D_EN)) {
      expect({ key, placeholders: placeholders(STREET3D_ES[key]) }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  test('every contribution status and report reason has its strings', () => {
    for (const state of CAPTURE_ASSET_STATES) {
      for (const privacy of CAPTURE_PRIVACY_STATES) {
        const status = contributionStatus({ state, privacy: { state: privacy } });
        expect(STREET3D_EN[status.titleKey]).toBeDefined();
        expect(STREET3D_EN[status.bodyKey]).toBeDefined();
      }
    }
    for (const reason of STREET_SCENE_REPORT_REASONS) {
      expect(STREET3D_EN[`street3d.report.reason.${reason}`]).toBeDefined();
    }
  });

  test('no copy says a published scene will disappear', () => {
    for (const text of Object.values(STREET3D_EN)) {
      expect(text).not.toMatch(/scene (will|may) (disappear|be deleted|expire)/i);
      expect(text).not.toMatch(/3D view (will|may) (disappear|be deleted|expire)/i);
    }
  });
});
