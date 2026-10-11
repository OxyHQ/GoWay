/**
 * The live layer's strings, per locale.
 *
 * Kept in the feature rather than in `lib/i18n.tsx` on purpose: that table is
 * part of every first paint, and the live layer is a flag-gated chunk that
 * most visitors never load. The locale is still Oxy's (`useTranslation().locale`,
 * matched the way a label is), so the panel never disagrees with the chrome.
 * `__tests__/messages.test.ts` holds both locales to the same keys.
 */

import { formatMessage, type MessageValues, useTranslation } from '@/lib/i18n';
import { matchLanguageTag } from '@goway.to/sdk';

export const LIVE_EN: Record<string, string> = {
  'live.title': 'Live',
  'live.real':
    'Real vehicles from open feeds. Hollow ones are estimated from arrival times. Nothing here is simulated.',
  'live.kind.aircraft': 'Aircraft',
  'live.kind.transit': 'Transit',
  'live.kind.bikeshare': 'Bikes',
  'live.kind.vessel': 'Ships',
  'live.zoomIn': 'Zoom in to see live traffic.',
  'live.connecting': 'Connecting to live feeds…',
  'live.offline': 'Live feeds are unavailable right now.',
  'live.slowDown': 'Catching up…',
  'live.noSources': 'No live feed covers this area.',
  'live.updated.seconds': 'updated {count} s ago',
  'live.updated.minutes': 'updated {count} min ago',
  'live.updated.never': 'waiting for data',
  'live.status.idle': 'not in view',
  'live.status.starting': 'starting',
  'live.status.live': 'live',
  'live.status.stale': 'stale',
  'live.status.unavailable': 'unavailable',
  'live.detail.close': 'Close',
  'live.detail.age': 'Position {age} old',
  'live.detail.estimateAge': 'Predictions {age} old',
  'live.detail.stale': 'Stale: the source has not reported a newer position.',
  'live.detail.onTrack':
    'Drawn on its line as published by the operator; moves along it between reports.',
  'live.detail.approximate':
    'Approximate: not on a published track. Shown where reported, not animated.',
  'live.detail.estimated':
    'Estimated from arrival predictions, not a GPS position: placed along its line between stops.',
  'live.detail.source': 'Source',
  'live.detail.licence': 'Licence',
  'live.detail.altitude': 'Altitude',
  'live.detail.onGround': 'On the ground',
  'live.detail.speed': 'Speed',
  'live.detail.heading': 'Heading',
  'live.detail.climb': 'Vertical rate',
  'live.detail.registration': 'Registration',
  'live.detail.type': 'Aircraft type',
  'live.detail.line': 'Line',
  'live.detail.vehicle': 'Vehicle',
  'live.detail.operator': 'Operator',
  'live.detail.bikes': 'Bikes available',
  'live.detail.ebikes': 'Electric',
  'live.detail.docks': 'Free docks',
  'live.detail.notRenting': 'Not renting right now',
  'live.detail.status': 'Status',
  'live.detail.destination': 'Destination',
  'live.detail.mmsi': 'MMSI',
  'live.detail.unknownAircraft': 'Aircraft {icao}',
  'live.detail.unknownVessel': 'Vessel {mmsi}',
  'live.mode.bus': 'Bus',
  'live.mode.tram': 'Tram',
  'live.mode.subway': 'Metro',
  'live.mode.rail': 'Train',
  'live.mode.ferry': 'Ferry',
  'live.mode.cable': 'Cable car',
  'live.mode.other': 'Vehicle',
};

export const LIVE_ES: Record<string, string> = {
  'live.title': 'En directo',
  'live.real':
    'Vehículos reales de fuentes abiertas. Los huecos se estiman a partir de las horas de llegada. Nada de esto es simulado.',
  'live.kind.aircraft': 'Aviones',
  'live.kind.transit': 'Transporte',
  'live.kind.bikeshare': 'Bicis',
  'live.kind.vessel': 'Barcos',
  'live.zoomIn': 'Acércate para ver el tráfico en directo.',
  'live.connecting': 'Conectando con las fuentes en directo…',
  'live.offline': 'Las fuentes en directo no están disponibles ahora.',
  'live.slowDown': 'Poniéndose al día…',
  'live.noSources': 'Ninguna fuente en directo cubre esta zona.',
  'live.updated.seconds': 'actualizado hace {count} s',
  'live.updated.minutes': 'actualizado hace {count} min',
  'live.updated.never': 'esperando datos',
  'live.status.idle': 'fuera de vista',
  'live.status.starting': 'iniciando',
  'live.status.live': 'en directo',
  'live.status.stale': 'desactualizado',
  'live.status.unavailable': 'no disponible',
  'live.detail.close': 'Cerrar',
  'live.detail.age': 'Posición de hace {age}',
  'live.detail.estimateAge': 'Previsiones de hace {age}',
  'live.detail.stale': 'Desactualizado: la fuente no ha enviado una posición más reciente.',
  'live.detail.onTrack':
    'Dibujado sobre su línea tal como la publica el operador; avanza por ella entre informes.',
  'live.detail.approximate':
    'Aproximado: fuera de una vía publicada. Se muestra donde se informó, sin animar.',
  'live.detail.estimated':
    'Estimado a partir de las previsiones de llegada, no es una posición GPS: situado sobre su línea entre paradas.',
  'live.detail.source': 'Fuente',
  'live.detail.licence': 'Licencia',
  'live.detail.altitude': 'Altitud',
  'live.detail.onGround': 'En tierra',
  'live.detail.speed': 'Velocidad',
  'live.detail.heading': 'Rumbo',
  'live.detail.climb': 'Velocidad vertical',
  'live.detail.registration': 'Matrícula',
  'live.detail.type': 'Tipo de aeronave',
  'live.detail.line': 'Línea',
  'live.detail.vehicle': 'Vehículo',
  'live.detail.operator': 'Operador',
  'live.detail.bikes': 'Bicis disponibles',
  'live.detail.ebikes': 'Eléctricas',
  'live.detail.docks': 'Anclajes libres',
  'live.detail.notRenting': 'No presta bicis ahora',
  'live.detail.status': 'Estado',
  'live.detail.destination': 'Destino',
  'live.detail.mmsi': 'MMSI',
  'live.detail.unknownAircraft': 'Aeronave {icao}',
  'live.detail.unknownVessel': 'Buque {mmsi}',
  'live.mode.bus': 'Autobús',
  'live.mode.tram': 'Tranvía',
  'live.mode.subway': 'Metro',
  'live.mode.rail': 'Tren',
  'live.mode.ferry': 'Ferri',
  'live.mode.cable': 'Teleférico',
  'live.mode.other': 'Vehículo',
};

const TABLES: Record<string, Record<string, string>> = { en: LIVE_EN, es: LIVE_ES };

export type LiveText = (key: string, values?: MessageValues) => string;

/** The live strings in Oxy's language, English for any key a locale lacks. */
export function useLiveText(): LiveText {
  const { locale } = useTranslation();
  const table = TABLES[matchLanguageTag(Object.keys(TABLES), locale) ?? 'en'] ?? LIVE_EN;
  return (key, values) => formatMessage(table[key] ?? LIVE_EN[key] ?? key, values);
}
