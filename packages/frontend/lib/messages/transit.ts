/**
 * Nearby public transport strings, per locale (`features/explore/PlaceTransitSection.tsx`).
 *
 * Kept beside the saved and credits strings: a feature's words, not the map's.
 * `__tests__/transit.test.ts` asserts every locale carries every key with the
 * same placeholders. The words Bloom's own `PlaceTransit` speaks (line, towards,
 * the mode names) are Bloom's and follow `BloomProvider`'s locale.
 *
 * An operator's credit and licence names are NOT here: they are the operator's
 * own text, shown as the API returns them.
 */

export const TRANSIT_EN: Record<string, string> = {
  'transit.heading': 'Public transport nearby',
  'transit.label': 'Public transport near this place',
  'transit.live': 'live',
  'transit.now': 'Now',
  'transit.minutes': '{count} min',
  'transit.empty': 'No departures in the next hours',
  'transit.note':
    "Times with a dot are the operator's live predictions. The others follow its published timetable.",
  'transit.noteScheduled': "These times follow the operator's published timetable.",
  'transit.updated': 'Updated {time}',
};

export const TRANSIT_ES: Record<string, string> = {
  'transit.heading': 'Transporte público cercano',
  'transit.label': 'Transporte público cerca de este lugar',
  'transit.live': 'en directo',
  'transit.now': 'Ahora',
  'transit.minutes': '{count} min',
  'transit.empty': 'Sin salidas en las próximas horas',
  'transit.note':
    'Las horas con un punto son predicciones en directo del operador. Las demás siguen su horario publicado.',
  'transit.noteScheduled': 'Estas horas siguen el horario publicado por el operador.',
  'transit.updated': 'Actualizado {time}',
};
