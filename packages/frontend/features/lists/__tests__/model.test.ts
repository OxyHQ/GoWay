import { describe, expect, it } from 'bun:test';
import { parseUtcInput, utcInput } from '../model';
describe('activity schedule entry', () => {
  it('round trips exact UTC minutes and refuses normalization of nonexistent dates', () => {
    expect(parseUtcInput('2030-03-31 01:30')).toBe('2030-03-31T01:30:00.000Z');
    expect(utcInput('2030-03-31T01:30:00.000Z')).toBe('2030-03-31 01:30');
    for (const value of ['2030-02-30 10:00', '2030-10-01 25:00', '2030-10-01T10:00', 'tomorrow'])
      expect(() => parseUtcInput(value)).toThrow();
  });
});
