import { describe, expect, it } from 'bun:test';
import { defined } from './defined';

describe('defined', () => {
  it('returns a present value unchanged, falsy ones included', () => {
    expect(defined(0)).toBe(0);
    expect(defined('')).toBe('');
    expect(defined(false)).toBe(false);
  });

  it('throws on null and undefined, naming what was missing', () => {
    expect(() => defined(null)).toThrow('Expected a value, got null.');
    expect(() => defined(undefined, 'the stored row')).toThrow(
      'Expected the stored row, got undefined.',
    );
  });
});
