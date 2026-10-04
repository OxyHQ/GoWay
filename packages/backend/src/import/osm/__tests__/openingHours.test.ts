/**
 * The OpenStreetMap `opening_hours` subset: what is read as a week, and what is
 * refused rather than guessed at.
 */

import { describe, expect, test } from 'bun:test';
import { osmOpeningHoursParser } from '../openingHours';

const parse = (raw: string) => osmOpeningHoursParser.parse(raw);
const week = (raw: string) => parse(raw).intervals.map(({ day, opens, closes }) => `${day} ${opens}-${closes}`);

describe('osmOpeningHoursParser', () => {
  test('reads weekday ranges, lists and split shifts', () => {
    expect(week('Mo-Fr 09:00-13:00,16:00-20:00; Sa 10:00-14:00')).toEqual([
      '1 09:00-13:00',
      '1 16:00-20:00',
      '2 09:00-13:00',
      '2 16:00-20:00',
      '3 09:00-13:00',
      '3 16:00-20:00',
      '4 09:00-13:00',
      '4 16:00-20:00',
      '5 09:00-13:00',
      '5 16:00-20:00',
      '6 10:00-14:00',
    ]);
    expect(week('Tu,Th 10:00 - 12:00')).toEqual(['2 10:00-12:00', '4 10:00-12:00']);
  });

  test('lets a later rule replace the days it names, as OpenStreetMap does', () => {
    expect(week('Mo-Sa 09:00-20:00; Sa 10:00-14:00; Su off').filter((entry) => entry.startsWith('6') || entry.startsWith('0'))).toEqual([
      '6 10:00-14:00',
    ]);
  });

  test('reads 24/7, a time with no weekday, a wrapping range and hours past midnight', () => {
    expect(week('24/7')).toHaveLength(7);
    expect(week('24/7')[0]).toBe('0 00:00-00:00');
    expect(week('10:00-20:00')).toHaveLength(7);
    expect(week('Fr-Mo 18:00-22:00').map((entry) => entry[0])).toEqual(['0', '1', '5', '6']);
    expect(week('Fr 22:00-26:00')).toEqual(['5 22:00-02:00']);
    expect(week('Sa 00:00-24:00')).toEqual(['6 00:00-00:00']);
  });

  test('drops public holidays, which are exceptions rather than part of a week', () => {
    expect(week('Mo-Fr 09:00-18:00; PH off')).toHaveLength(5);
    expect(week('Su,PH 10:00-14:00')).toEqual(['0 10:00-14:00']);
  });

  test('keeps the raw expression and claims no hours for anything outside the subset', () => {
    for (const raw of [
      'Jun-Sep Mo-Su 10:00-22:00',
      'Mo-Fr 09:00-18:00 || "by appointment"',
      'Mo-Fr 18:00+',
      'sunrise-sunset',
      'Mo[1] 10:00-12:00',
      'Mo-Fr 09:00-18:00, Sa 10:00-14:00',
      'SH off',
      'Mon-Fri 9-5',
    ]) {
      expect({ raw, parsed: parse(raw) }).toEqual({ raw, parsed: { intervals: [], raw } });
    }
  });
});
