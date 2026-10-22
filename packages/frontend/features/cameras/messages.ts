/**
 * The cameras layer's strings, per locale.
 *
 * Kept in the feature rather than in `lib/i18n.tsx` on purpose: that table is
 * part of every first paint, and the camera layer is an optional chunk. The
 * locale is still Oxy's (`useTranslation().locale`, matched the way a label
 * is), so the screen never disagrees with the chrome. `__tests__/messages.test.ts`
 * holds both locales to the same keys.
 *
 * Copy rules (`docs/MAP_LIVE.md`, applied here): say how old the picture is,
 * never imply it is fresher than it is, and credit the source.
 */

import { matchLanguageTag } from '@goway.to/sdk';

import { formatMessage, type MessageValues, useTranslation } from '@/lib/i18n';

export const CAMERAS_EN: Record<string, string> = {
  'cameras.open': 'Camera: {name}',
  'cameras.close': 'Close',
  'cameras.loading': 'Loading the camera…',
  'cameras.notFound': 'This camera is no longer listed.',
  'cameras.failed': 'The camera could not be loaded.',
  'cameras.retry': 'Try again',
  'cameras.status.live': 'Up to date',
  'cameras.status.stale': 'Out of date',
  'cameras.status.offline': 'Offline',
  'cameras.status.unknown': 'No picture seen yet',
  'cameras.age': 'Picture {age} old',
  'cameras.stale': 'Out of date: the camera has not sent a newer picture.',
  'cameras.offline': 'This camera is not sending pictures right now. What is shown may be old.',
  'cameras.pictureFailed': 'The picture could not be loaded right now.',
  'cameras.notServed': 'GoWay lists this camera but does not show its picture.',
  'cameras.refreshes': 'The picture refreshes about every {seconds} s.',
  'cameras.licence': 'Licence',
  'cameras.counted': 'Counted in the last minute',
  'cameras.privacy': 'Only counts are kept: GoWay stores no pictures, faces or number plates.',
  'cameras.class.car': 'Cars',
  'cameras.class.truck': 'Trucks',
  'cameras.class.bus': 'Buses',
  'cameras.class.motorcycle': 'Motorcycles',
  'cameras.class.bicycle': 'Bicycles',
  'cameras.class.pedestrian': 'People',
  'cameras.congestion.free': 'Traffic is flowing',
  'cameras.congestion.busy': 'Busy',
  'cameras.congestion.slow': 'Slow',
  'cameras.congestion.stopped': 'Stopped',
  'cameras.health.dark': 'Too dark to count.',
  'cameras.health.obstructed': 'The view is obstructed, so counts may be off.',
  'cameras.health.frozen': 'The picture is not changing, so nothing is counted.',
};

export const CAMERAS_ES: Record<string, string> = {
  'cameras.open': 'Cámara: {name}',
  'cameras.close': 'Cerrar',
  'cameras.loading': 'Cargando la cámara…',
  'cameras.notFound': 'Esta cámara ya no figura en la lista.',
  'cameras.failed': 'No se pudo cargar la cámara.',
  'cameras.retry': 'Reintentar',
  'cameras.status.live': 'Al día',
  'cameras.status.stale': 'Desactualizada',
  'cameras.status.offline': 'Sin conexión',
  'cameras.status.unknown': 'Aún sin imagen',
  'cameras.age': 'Imagen de hace {age}',
  'cameras.stale': 'Desactualizada: la cámara no ha enviado una imagen más reciente.',
  'cameras.offline': 'Esta cámara no envía imágenes ahora mismo. Lo que se ve puede ser antiguo.',
  'cameras.pictureFailed': 'No se pudo cargar la imagen ahora mismo.',
  'cameras.notServed': 'GoWay lista esta cámara, pero no muestra su imagen.',
  'cameras.refreshes': 'La imagen se actualiza cada {seconds} s aproximadamente.',
  'cameras.licence': 'Licencia',
  'cameras.counted': 'Contado en el último minuto',
  'cameras.privacy': 'Solo se guardan recuentos: GoWay no almacena imágenes, caras ni matrículas.',
  'cameras.class.car': 'Coches',
  'cameras.class.truck': 'Camiones',
  'cameras.class.bus': 'Autobuses',
  'cameras.class.motorcycle': 'Motos',
  'cameras.class.bicycle': 'Bicicletas',
  'cameras.class.pedestrian': 'Personas',
  'cameras.congestion.free': 'El tráfico fluye',
  'cameras.congestion.busy': 'Con tráfico',
  'cameras.congestion.slow': 'Lento',
  'cameras.congestion.stopped': 'Detenido',
  'cameras.health.dark': 'Demasiado oscuro para contar.',
  'cameras.health.obstructed': 'La vista está obstruida, así que los recuentos pueden fallar.',
  'cameras.health.frozen': 'La imagen no cambia, así que no se cuenta nada.',
};

const TABLES: Record<string, Record<string, string>> = { en: CAMERAS_EN, es: CAMERAS_ES };

export type CameraText = (key: string, values?: MessageValues) => string;

/** The camera strings in Oxy's language, English for any key a locale lacks. */
export function useCameraText(): CameraText {
  const { locale } = useTranslation();
  const table = TABLES[matchLanguageTag(Object.keys(TABLES), locale) ?? 'en'] ?? CAMERAS_EN;
  return (key, values) => formatMessage(table[key] ?? CAMERAS_EN[key] ?? key, values);
}
