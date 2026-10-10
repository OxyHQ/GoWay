import { describe, expect, test } from 'bun:test';
import type { CaptureAsset } from '@goway.to/sdk';
import { CAPTURE_ASSET_STATES, CAPTURE_PRIVACY_STATES } from '@goway.to/sdk';

import { contributionStatus, sourceExpiry } from '../status';

type Input = Pick<CaptureAsset, 'state' | 'privacy'>;
const asset = (state: Input['state'], privacy: Input['privacy']['state']): Input => ({
  state,
  privacy: { state: privacy },
});

describe('contributionStatus', () => {
  test('every (state, privacy) pair maps to a status with message keys', () => {
    for (const state of CAPTURE_ASSET_STATES) {
      for (const privacy of CAPTURE_PRIVACY_STATES) {
        const result = contributionStatus(asset(state, privacy));
        expect(result.titleKey).toBe(`contribute.status.${result.key}.title`);
        expect(result.bodyKey).toBe(`contribute.status.${result.key}.body`);
      }
    }
  });

  test('"accepted" before privacy has run says privacy is pending, not done', () => {
    expect(contributionStatus(asset('accepted', 'pending')).key).toBe('privacyPending');
    expect(contributionStatus(asset('uploaded', 'pending')).key).toBe('privacyPending');
    expect(contributionStatus(asset('uploaded', 'in_progress')).key).toBe('privacyProcessing');
    expect(contributionStatus(asset('accepted', 'passed')).key).toBe('accepted');
    expect(contributionStatus(asset('accepted', 'passed')).privacyPassed).toBe(true);
  });

  test('a privacy failure or a block is terminal whatever the pipeline says', () => {
    expect(contributionStatus(asset('waiting_for_overlap', 'failed'))).toMatchObject({
      key: 'privacyFailed',
      terminal: true,
    });
    expect(contributionStatus(asset('accepted', 'blocked'))).toMatchObject({
      key: 'blocked',
      terminal: true,
    });
  });

  test('the overlap and reconstruction states are reported as themselves', () => {
    expect(contributionStatus(asset('waiting_for_overlap', 'passed'))).toMatchObject({
      key: 'waitingForOverlap',
      canStillHelp: true,
    });
    expect(contributionStatus(asset('reconstruction_candidate', 'passed'))).toMatchObject({
      key: 'reconstructionCandidate',
    });
    expect(contributionStatus(asset('integrated', 'passed'))).toMatchObject({
      key: 'integrated',
      tone: 'success',
    });
  });

  test('ends win over privacy, and cannot still help an area', () => {
    for (const state of ['deleted', 'expired', 'abandoned', 'rejected'] as const) {
      const result = contributionStatus(asset(state, 'passed'));
      expect(result.terminal).toBe(true);
      expect(result.canStillHelp).toBe(false);
    }
    expect(contributionStatus(asset('expired', 'passed')).key).toBe('expired');
  });
});

describe('sourceExpiry', () => {
  const lifecycle = (extra: Partial<CaptureAsset['media']['lifecycle']> = {}) =>
    ({
      retentionClass: 'raw_photo',
      retentionReason: 'awaiting_overlap',
      storedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
      extensionCount: 0,
      ...extra,
    }) as CaptureAsset['media']['lifecycle'];
  const media = (extra?: Partial<CaptureAsset['media']['lifecycle']>) =>
    ({ lifecycle: lifecycle(extra) }) as CaptureAsset['media'];
  const now = Date.parse('2026-10-04T00:00:00.000Z');

  test('reports the lifecycle expiry', () => {
    expect(sourceExpiry({ state: 'waiting_for_overlap', media: media() }, now)).toEqual({
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
  });

  test('includes a protection that is still in force, and drops a lapsed one', () => {
    expect(
      sourceExpiry(
        {
          state: 'waiting_for_overlap',
          media: media({ protectedUntil: '2026-11-20T00:00:00.000Z' }),
        },
        now,
      ),
    ).toEqual({
      expiresAt: '2026-11-01T00:00:00.000Z',
      protectedUntil: '2026-11-20T00:00:00.000Z',
    });
    expect(
      sourceExpiry(
        {
          state: 'waiting_for_overlap',
          media: media({ protectedUntil: '2026-09-20T00:00:00.000Z' }),
        },
        now,
      ),
    ).toEqual({ expiresAt: '2026-11-01T00:00:00.000Z' });
  });

  test('nothing for a source that is already gone', () => {
    expect(sourceExpiry({ state: 'expired', media: media() }, now)).toBeNull();
    expect(sourceExpiry({ state: 'deleted', media: media() }, now)).toBeNull();
    expect(
      sourceExpiry(
        { state: 'integrated', media: media({ deletedAt: '2026-10-01T00:00:00.000Z' }) },
        now,
      ),
    ).toBeNull();
  });
});
