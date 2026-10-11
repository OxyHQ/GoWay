/**
 * OSM tag → city-tile property parsing, junk included. Every value rejected
 * here is one a real extract carries (`build-city-tiles.ts` prints the
 * rejected counts per key); every value accepted is one the wiki documents or
 * mappers demonstrably write.
 */
import { describe, expect, test } from 'bun:test';

import { METRES_PER_LEVEL, UNKNOWN_HEIGHT_M } from '../../lib/map/cityTiles';
import {
  buildingKind,
  defaultRoofHeight,
  parseAngle,
  parseColour,
  parseDirection,
  parseLength,
  parseLevels,
  parseOrientation,
  parseRoofMaterial,
  parseRoofShape,
  parseWallMaterial,
  parseBuildingEra,
  parseBuildingUse,
  resolveProperties,
} from '../citygen/tags';

describe('parseLength', () => {
  test('metres, with and without a unit, and a decimal comma', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12.5')).toBe(12.5);
    expect(parseLength('12,5')).toBe(12.5);
    expect(parseLength('12 m')).toBe(12);
    expect(parseLength('12m')).toBe(12);
    expect(parseLength(' 7 metres ')).toBe(7);
  });

  test('feet and inches', () => {
    expect(parseLength("40'")).toBeCloseTo(12.192, 3);
    expect(parseLength('40 ft')).toBeCloseTo(12.192, 3);
    expect(parseLength('40\'6"')).toBeCloseTo(12.344, 3);
  });

  test('junk is dropped, never coerced', () => {
    for (const junk of [
      'yes',
      '~12',
      '12;15',
      '10-12',
      '-5',
      '1e3',
      '',
      'NaN',
      'Infinity',
      '12 floors',
      '1200',
    ]) {
      expect(parseLength(junk)).toBeUndefined();
    }
    expect(parseLength(undefined)).toBeUndefined();
  });

  test('zero is a height only where it is a fact (min_height)', () => {
    expect(parseLength('0')).toBeUndefined();
    expect(parseLength('0', true)).toBe(0);
  });
});

describe('parseLevels', () => {
  test('whole storeys only', () => {
    expect(parseLevels('5')).toBe(5);
    expect(parseLevels('0')).toBe(0);
    for (const junk of ['2.5', '-1', 'three', '5;6', '5+1', '250', '']) {
      expect(parseLevels(junk)).toBeUndefined();
    }
  });
});

describe('roof vocabulary', () => {
  test('shapes and their common spellings', () => {
    expect(parseRoofShape('gabled')).toBe('gabled');
    expect(parseRoofShape(' Hipped ')).toBe('hipped');
    expect(parseRoofShape('pitched')).toBe('gabled');
    expect(parseRoofShape('half_hipped')).toBe('half-hipped');
    expect(parseRoofShape('pyramid')).toBe('pyramidal');
    expect(parseRoofShape('lean_to')).toBe('skillion');
    expect(parseRoofShape('crosspitched')).toBeUndefined();
    expect(parseRoofShape('yes')).toBeUndefined();
  });

  test('direction: degrees (wrapped) or one of sixteen points', () => {
    expect(parseDirection('90')).toBe(90);
    expect(parseDirection('-90')).toBe(270);
    expect(parseDirection('370')).toBe(10);
    expect(parseDirection('N')).toBe(0);
    expect(parseDirection('nnw')).toBe(337.5);
    expect(parseDirection('SE')).toBe(135);
    expect(parseDirection('north')).toBeUndefined();
    expect(parseDirection('90;180')).toBeUndefined();
  });

  test('orientation and angle', () => {
    expect(parseOrientation('across')).toBe('across');
    expect(parseOrientation('Along')).toBe('along');
    expect(parseOrientation('diagonal')).toBeUndefined();
    expect(parseAngle('30')).toBe(30);
    expect(parseAngle('30°')).toBe(30);
    expect(parseAngle('0')).toBeUndefined();
    expect(parseAngle('90')).toBeUndefined();
  });
});

describe('parseColour', () => {
  test('hex, short hex, bare hex and CSS names', () => {
    expect(parseColour('#AABBCC')).toBe('#aabbcc');
    expect(parseColour('#abc')).toBe('#aabbcc');
    expect(parseColour('aabbcc')).toBe('#aabbcc');
    expect(parseColour('white')).toBe('#ffffff');
    expect(parseColour('light grey')).toBe('#d3d3d3');
    expect(parseColour('light_grey')).toBe('#d3d3d3');
    expect(parseColour('Dark-Red')).toBe('#8b0000');
  });

  test('a look is not a colour', () => {
    for (const junk of ['brick', 'multi', '#12345', 'rgb(1,2,3)', 'yes', '']) {
      expect(parseColour(junk)).toBeUndefined();
    }
  });
});

describe('materials', () => {
  test('vocabularies and aliases', () => {
    expect(parseWallMaterial('brick')).toBe('brick');
    expect(parseWallMaterial('bricks')).toBe('brick');
    expect(parseWallMaterial('reinforced concrete')).toBe('concrete');
    expect(parseWallMaterial('cardboard')).toBeUndefined();
    expect(parseRoofMaterial('tiles')).toBe('roof_tiles');
    expect(parseRoofMaterial('metal_sheet')).toBe('metal');
    expect(parseRoofMaterial('copper')).toBe('copper');
    expect(parseRoofMaterial('unknown')).toBeUndefined();
  });
});

describe('buildingKind', () => {
  test('outlines, parts, and what is neither', () => {
    expect(buildingKind({ building: 'yes' })).toBe('building');
    expect(buildingKind({ building: 'apartments' })).toBe('building');
    expect(buildingKind({ 'building:part': 'yes' })).toBe('part');
    expect(buildingKind({ building: 'yes', 'building:part': 'yes' })).toBe('part');
    expect(buildingKind({ building: 'no' })).toBeNull();
    expect(buildingKind({ building: 'yes', location: 'underground' })).toBeNull();
    expect(buildingKind({ amenity: 'cafe' })).toBeNull();
  });
});

describe('resolveProperties', () => {
  const span = { halfWidth: 5, halfLength: 10 };

  test('untagged stands as OpenMapTiles stands it: 5 m, on the ground', () => {
    const props = resolveProperties({ building: 'yes' }, 'building', span);
    expect(props.render_height).toBe(UNKNOWN_HEIGHT_M);
    expect(props.render_min_height).toBe(0);
    expect(props.levels).toBeUndefined();
    expect(props.roof_shape).toBeUndefined();
  });

  test('levels × 3.66, with a recorded roof stacked on top', () => {
    const flat = resolveProperties({ building: 'yes', 'building:levels': '6' }, 'building', span);
    expect(flat.render_height).toBe(Math.round(6 * METRES_PER_LEVEL * 10) / 10);
    expect(flat.levels).toBe(6);
    const roofed = resolveProperties(
      { building: 'yes', 'building:levels': '2', 'roof:shape': 'gabled', 'roof:height': '3' },
      'building',
      span,
    );
    expect(roofed.render_height).toBe(Math.round((2 * METRES_PER_LEVEL + 3) * 10) / 10);
    expect(roofed.roof_height).toBe(3);
    expect(roofed.roof_height_source).toBe('tag');
  });

  test('a recorded height or storey count is said to be from OSM; the 5 m default is not', () => {
    expect(resolveProperties({ building: 'yes' }, 'building', span).height_source).toBeUndefined();
    expect(
      resolveProperties({ building: 'yes', height: '20' }, 'building', span).height_source,
    ).toBe('osm');
    expect(
      resolveProperties({ building: 'yes', 'building:levels': '6' }, 'building', span)
        .height_source,
    ).toBe('osm');
    // A roof alone records no height: the block under it is still the default.
    expect(
      resolveProperties(
        { building: 'yes', 'roof:shape': 'gabled', 'roof:height': '3' },
        'building',
        span,
      ).height_source,
    ).toBeUndefined();
  });

  test('a tagged height is the top of the roof; the roof is carved out of it', () => {
    const props = resolveProperties(
      { building: 'yes', height: '12', 'roof:shape': 'hipped', 'roof:levels': '1' },
      'building',
      span,
    );
    expect(props.render_height).toBe(12);
    expect(props.roof_height).toBe(Math.round(METRES_PER_LEVEL * 10) / 10);
    expect(props.roof_height_source).toBe('levels');
  });

  test('a shape alone gets a default pitch, said to be a default, capped at half the building', () => {
    const props = resolveProperties(
      { building: 'yes', height: '6', 'roof:shape': 'gabled' },
      'building',
      { halfWidth: 20, halfLength: 30 },
    );
    expect(props.roof_height_source).toBe('default');
    // 20 m × tan 30° = 11.5 m, but at most half of a 6 m building.
    expect(props.roof_height).toBe(3);
  });

  test('a shape with no frame to size it draws flat', () => {
    const props = resolveProperties(
      { building: 'yes', 'roof:shape': 'gabled' },
      'building',
      undefined,
    );
    expect(props.roof_shape).toBeUndefined();
    expect(props.roof_height).toBeUndefined();
  });

  test('min_height at or above the top drops to the ground (an inverted prism is junk)', () => {
    const props = resolveProperties(
      { building: 'yes', height: '5', min_height: '37' },
      'building',
      span,
    );
    expect(props.render_min_height).toBe(0);
    const levels = resolveProperties(
      { 'building:part': 'yes', 'building:levels': '8', 'building:min_level': '3' },
      'part',
      span,
    );
    expect(levels.render_min_height).toBe(Math.round(3 * METRES_PER_LEVEL * 10) / 10);
    expect(levels.part).toBe(true);
  });

  test('building=roof is a roof on pillars', () => {
    const props = resolveProperties({ building: 'roof', height: '6' }, 'building', span);
    expect(props.render_min_height).toBe(5);
  });

  test('junk tags leave no trace in the tile', () => {
    const props = resolveProperties(
      {
        building: 'yes',
        height: 'yes',
        'building:levels': '2.5',
        'roof:shape': 'unknown',
        'building:colour': 'multi',
        'roof:direction': 'up',
      },
      'building',
      span,
    );
    expect(Object.keys(props).sort()).toEqual(['render_height', 'render_min_height']);
  });

  test('colours, materials and orientation are carried normalised', () => {
    const props = resolveProperties(
      {
        building: 'yes',
        'building:colour': 'Light Grey',
        'roof:colour': '#A52',
        'building:material': 'bricks',
        'roof:material': 'tiles',
        'roof:shape': 'gabled',
        'roof:orientation': 'across',
        'roof:direction': 'SW',
        'roof:height': '2',
      },
      'building',
      span,
    );
    expect(props.colour).toBe('#d3d3d3');
    expect(props.roof_colour).toBe('#aa5522');
    expect(props.material).toBe('brick');
    expect(props.roof_material).toBe('roof_tiles');
    expect(props.roof_orientation).toBe('across');
    expect(props.roof_direction).toBe(225);
  });
});

describe('defaultRoofHeight', () => {
  test('pitch over the half-width; domes by their radius', () => {
    const span = { halfWidth: 4, halfLength: 8 };
    expect(defaultRoofHeight('gabled', span)).toBeCloseTo(4 * Math.tan(Math.PI / 6), 6);
    expect(defaultRoofHeight('gabled', span, 45)).toBeCloseTo(4, 6);
    expect(defaultRoofHeight('dome', span)).toBe(4);
    expect(defaultRoofHeight('flat', span)).toBe(0);
  });
});

describe('facade styling vocabulary', () => {
  test('building=* → a class, and `yes` (or anything unlisted) → none', () => {
    expect(parseBuildingUse('apartments')).toBe('residential');
    expect(parseBuildingUse(' Office ')).toBe('commercial');
    expect(parseBuildingUse('school')).toBe('civic');
    expect(parseBuildingUse('cathedral')).toBe('religious');
    expect(parseBuildingUse('warehouse')).toBe('industrial');
    expect(parseBuildingUse('yes')).toBeUndefined();
    expect(parseBuildingUse('ruins')).toBeUndefined();
    expect(parseBuildingUse(undefined)).toBeUndefined();
  });

  test('start_date → an era from a leading year only', () => {
    expect(parseBuildingEra('1882')).toBe('historic');
    expect(parseBuildingEra('1931-05-01')).toBe('early_modern');
    expect(parseBuildingEra('~1960')).toBe('modern');
    expect(parseBuildingEra('1930..1932')).toBe('early_modern');
    expect(parseBuildingEra('before 1899')).toBe('historic');
    for (const refused of ['C19', '1930s', 'late 19th century', '31', '19311', '', undefined]) {
      expect(parseBuildingEra(refused)).toBeUndefined();
    }
  });

  test('resolveProperties writes them when tagged', () => {
    const props = resolveProperties(
      { building: 'church', start_date: '1450' },
      'building',
      undefined,
    );
    expect(props).toMatchObject({ use: 'religious', era: 'historic' });
    expect(resolveProperties({ building: 'yes' }, 'building', undefined).use).toBeUndefined();
  });
});
