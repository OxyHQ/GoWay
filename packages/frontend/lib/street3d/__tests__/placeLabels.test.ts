import { describe, expect, test } from 'bun:test';
import type { Place } from '@goway.to/sdk';
import type { StreetSceneWorldTransform } from '@goway.to/sdk';

import { geodeticToEnu, transformPoint } from '../geodesy';
import { placeLabelsForScene } from '../placeLabels';

const anchor = { latitude: 41.381, longitude: 2.1725, altitudeMeters: 52 };
/** Y-up: scene x → E, scene y → U, scene z → S. Column-major. */
const Y_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const transform: StreetSceneWorldTransform = { anchor, frame: 'enu', enuFromScene: Y_UP };

function place(id: string, latitude: number, longitude: number, extra: Partial<Place> = {}): Place {
  return { id, name: id, location: { latitude, longitude }, ...extra } as Place;
}

describe('placeLabelsForScene', () => {
  test('a place north of the anchor lands at -z (south is +z) and at label height', () => {
    const [label] = placeLabelsForScene(
      [place('n', anchor.latitude + 0.0005, anchor.longitude)],
      transform,
      { heightMeters: 3 },
    );
    expect(label.position[0]).toBeCloseTo(0, 3);
    expect(label.position[1]).toBeCloseTo(3, 2);
    expect(label.position[2]).toBeLessThan(-50);
    expect(label.position[2]).toBeGreaterThan(-60);
  });

  test('round-trips through enuFromScene back to the place', () => {
    const target = place('p', 41.3817, 2.1716);
    const [label] = placeLabelsForScene([target], transform, { heightMeters: 0 });
    const enu = transformPoint(Y_UP, label.position);
    const expected = geodeticToEnu(
      { ...target.location, altitudeMeters: anchor.altitudeMeters },
      anchor,
    );
    enu.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
  });

  test('uses the localized display name, nearest first, capped and de-duplicated', () => {
    const places = [
      place('far', anchor.latitude + 0.002, anchor.longitude),
      place('near', anchor.latitude + 0.0002, anchor.longitude, {
        localizedName: { name: 'Cerca', language: 'es' } as Place['localizedName'],
      }),
      place('near', anchor.latitude + 0.0002, anchor.longitude),
      place('mid', anchor.latitude + 0.001, anchor.longitude),
    ];
    const labels = placeLabelsForScene(places, transform, { max: 2 });
    expect(labels.map((label) => label.id)).toEqual(['near', 'mid']);
    expect(labels[0].name).toBe('Cerca');
  });

  test('drops places beyond the distance limit and unnamed ones', () => {
    const labels = placeLabelsForScene(
      [
        place('way-off', anchor.latitude + 0.01, anchor.longitude),
        place('blank', anchor.latitude, anchor.longitude, { name: '  ' }),
      ],
      transform,
    );
    expect(labels).toEqual([]);
  });

  test('a transform that is not a similarity yields no labels rather than wrong ones', () => {
    const sheared = {
      ...transform,
      enuFromScene: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    expect(placeLabelsForScene([place('n', anchor.latitude, anchor.longitude)], sheared)).toEqual(
      [],
    );
  });
});
