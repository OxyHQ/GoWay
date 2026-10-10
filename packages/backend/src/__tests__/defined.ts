/**
 * The value, or a thrown error naming what was missing.
 *
 * Tests use this in place of a non-null assertion (`value!`). The assertion
 * only silences the type checker: a value that really is absent goes on as
 * `undefined` and fails somewhere later, with a TypeError that names neither
 * the value nor the step that produced it, or with no failure at all when the
 * next assertion happens to accept `undefined`. This narrows the type the same
 * way and fails at the point the value went missing.
 */
export function defined<T>(value: T | null | undefined, what = 'a value'): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what}, got ${value === null ? 'null' : 'undefined'}.`);
  }
  return value;
}
