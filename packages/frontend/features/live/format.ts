/**
 * What the live panel says about a thing and its source — pure, so the copy
 * is a test rather than a screenshot.
 */

import type { LiveEntity, LiveSource } from '@goway.to/sdk/live';

import type { LiveText } from './messages';

/** "4 s", "3 min", "2 h": an age a person reads at a glance. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** How fresh a source's last answer is, in words. */
export function sourceFreshness(source: LiveSource, serverNow: number, t: LiveText): string {
  if (!source.lastUpdatedAt) return t('live.updated.never');
  const seconds = Math.max(0, Math.round((serverNow - Date.parse(source.lastUpdatedAt)) / 1000));
  return seconds < 90
    ? t('live.updated.seconds', { count: seconds })
    : t('live.updated.minutes', { count: Math.round(seconds / 60) });
}

const number = (value: number, digits = 0) =>
  value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });

export interface DetailRow {
  label: string;
  value: string;
}

export interface EntityDetails {
  title: string;
  subtitle: string | null;
  rows: DetailRow[];
}

/** The title, subtitle and facts of one entity — only what its feed said. */
export function entityDetails(entity: LiveEntity, t: LiveText): EntityDetails {
  const rows: DetailRow[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label: t(label), value });
  };
  const speed = (metresPerSecond: number | null, unit: 'kmh' | 'kn') => {
    if (metresPerSecond === null) return null;
    return unit === 'kn'
      ? `${number(metresPerSecond / 0.514444, 1)} kn`
      : `${number(metresPerSecond * 3.6)} km/h`;
  };
  const heading = entity.headingDegrees === null ? null : `${number(entity.headingDegrees)}°`;

  switch (entity.kind) {
    case 'aircraft': {
      if (entity.onGround)
        rows.push({ label: t('live.detail.altitude'), value: t('live.detail.onGround') });
      else if (entity.altitudeMeters !== null)
        push(
          'live.detail.altitude',
          `${number(entity.altitudeMeters)} m (${number(entity.altitudeMeters / 0.3048)} ft)` +
            (entity.altitudeReference === 'barometric' ? ' · baro' : ''),
        );
      push('live.detail.speed', speed(entity.speedMetersPerSecond, 'kmh'));
      push('live.detail.heading', heading);
      if (
        entity.verticalRateMetersPerSecond !== null &&
        Math.abs(entity.verticalRateMetersPerSecond) >= 0.5
      )
        push(
          'live.detail.climb',
          `${entity.verticalRateMetersPerSecond > 0 ? '+' : ''}${number(entity.verticalRateMetersPerSecond, 1)} m/s`,
        );
      push('live.detail.registration', entity.registration);
      push('live.detail.type', entity.typeCode);
      return {
        title:
          entity.callsign ??
          t('live.detail.unknownAircraft', { icao: entity.icao24.toUpperCase() }),
        subtitle: [entity.typeCode, entity.registration].filter(Boolean).join(' · ') || null,
        rows,
      };
    }
    case 'transit': {
      const mode = t(`live.mode.${entity.mode}`);
      push('live.detail.line', entity.line);
      push('live.detail.vehicle', entity.vehicleLabel);
      push('live.detail.operator', entity.operator);
      push('live.detail.speed', speed(entity.speedMetersPerSecond, 'kmh'));
      push('live.detail.heading', heading);
      return {
        title: entity.line ? `${mode} ${entity.line}` : mode,
        subtitle: entity.headsign ?? entity.operator,
        rows,
      };
    }
    case 'bikeshare': {
      push('live.detail.bikes', number(entity.bikesAvailable));
      if (entity.ebikesAvailable !== null)
        push('live.detail.ebikes', number(entity.ebikesAvailable));
      if (entity.docksAvailable !== null) push('live.detail.docks', number(entity.docksAvailable));
      if (!entity.renting)
        rows.push({ label: t('live.detail.status'), value: t('live.detail.notRenting') });
      return { title: entity.name, subtitle: entity.operator, rows };
    }
    case 'vessel': {
      push('live.detail.status', entity.navigationalStatus);
      push('live.detail.speed', speed(entity.speedMetersPerSecond, 'kn'));
      push('live.detail.heading', heading);
      push('live.detail.destination', entity.destination);
      push('live.detail.mmsi', entity.mmsi);
      return {
        title: entity.name ?? t('live.detail.unknownVessel', { mmsi: entity.mmsi }),
        subtitle: entity.navigationalStatus,
        rows,
      };
    }
  }
}
