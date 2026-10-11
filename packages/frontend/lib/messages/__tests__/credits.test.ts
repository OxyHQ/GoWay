/**
 * The attribution page: both locales carry every heading, every section the
 * page renders has words, and the Copernicus notices are the licence's own.
 */
import { describe, expect, test } from 'bun:test';

import { COPERNICUS_NOTICES, CREDIT_SECTIONS } from '@/lib/map/credits';
import { resolveMapAttribution, TERRAIN_SOURCE_LINK } from '@/lib/map/provider';

import { CREDITS_EN, CREDITS_ES } from '../credits';

describe('the attribution page', () => {
  test('every locale carries exactly the same keys', () => {
    expect(Object.keys(CREDITS_ES).sort()).toEqual(Object.keys(CREDITS_EN).sort());
  });

  test('every section has a heading and a body', () => {
    for (const section of CREDIT_SECTIONS) {
      expect(CREDITS_EN[`credits.${section.id}.heading`]).toBeDefined();
      expect(CREDITS_EN[`credits.${section.id}.body`]).toBeDefined();
    }
  });

  test('the elevation section carries the Copernicus notice, the liability sentence and Mapterhorn', () => {
    const elevation = CREDIT_SECTIONS.find((section) => section.id === 'elevation');
    expect(elevation?.links).toContainEqual(TERRAIN_SOURCE_LINK);
    // Licence Article 6(b) and 6(c), verbatim.
    expect(elevation?.notices).toContain(
      'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    );
    expect(elevation?.notices).toContain(
      'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.',
    );
    expect(elevation?.notices).toContain(COPERNICUS_NOTICES.endorsement);
  });

  test("the map's elevation credit leads to this page's elevation section", () => {
    const credit = resolveMapAttribution({ terrain: true }).links.at(-1);
    expect(credit?.href).toBe('https://goway.to/attribution#elevation');
    expect(CREDIT_SECTIONS.map((section) => section.id)).toContain('elevation');
  });
});
