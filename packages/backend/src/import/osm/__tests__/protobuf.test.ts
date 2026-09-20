/**
 * The protobuf primitives, at the boundaries where a wrong decoder still
 * returns a number.
 */

import { describe, expect, test } from 'bun:test';
import {
  readFieldHeader,
  readPackedSignedVarints,
  readSignedVarint,
  readString,
  readVarint,
  reader,
  skipField,
} from '../protobuf';

/** The reference encoder, written from the format rather than from the decoder. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 128) + 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

describe('readVarint', () => {
  test('decodes values past 2^31, where a shift-based decoder wraps', () => {
    for (const value of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 32 + 7, 12_345_678_901]) {
      expect(readVarint(reader(Uint8Array.from(varint(value))))).toBe(value);
    }
  });

  test('refuses a value it cannot represent exactly rather than truncating it', () => {
    const tooLarge = varint(2 ** 40).concat();
    // Force an 11th continuation byte: a stream that is not protobuf.
    const runaway = Uint8Array.from(new Array(11).fill(0xff));
    expect(() => readVarint(reader(runaway))).toThrow(/not protobuf/);
    expect(readVarint(reader(Uint8Array.from(tooLarge)))).toBe(2 ** 40);
  });

  test('refuses a truncated value', () => {
    expect(() => readVarint(reader(Uint8Array.from([0x80])))).toThrow(/Truncated/);
  });
});

describe('readSignedVarint', () => {
  test('round-trips zigzag in both directions', () => {
    const zigzag = (value: number) => (value < 0 ? -value * 2 - 1 : value * 2);
    for (const value of [0, -1, 1, -2, 2, -64, 8_388_607, -8_388_608, 12_345_678_901]) {
      expect(readSignedVarint(reader(Uint8Array.from(varint(zigzag(value)))))).toBe(value);
    }
  });
});

describe('field headers and skipping', () => {
  test('splits a tag into field number and wire type', () => {
    const header = readFieldHeader(reader(Uint8Array.from(varint(3 * 8 + 2))));
    expect(header).toEqual({ field: 3, wire: 2 });
  });

  test('returns null at the end of a message', () => {
    expect(readFieldHeader(reader(Uint8Array.from([])))).toBeNull();
  });

  test('skips every wire type it does not decode', () => {
    const read = reader(Uint8Array.from([...varint(300), ...[1, 2, 3, 4, 5, 6, 7, 8]]));
    skipField(read, 0);
    skipField(read, 1);
    expect(read.pos).toBe(read.data.length);
  });
});

describe('strings and packed fields', () => {
  test('decodes UTF-8 rather than bytes', () => {
    const text = 'Museu Picasso — Barcelona';
    const bytes = Buffer.from(text, 'utf8');
    const read = reader(Uint8Array.from([...varint(bytes.length), ...bytes]));
    expect(readString(read)).toBe(text);
  });

  test('appends a packed field to the caller s scratch array', () => {
    const zigzag = (value: number) => (value < 0 ? -value * 2 - 1 : value * 2);
    const payload = [5, -3, 1].flatMap((value) => varint(zigzag(value)));
    const read = reader(Uint8Array.from([...varint(payload.length), ...payload]));
    const into: number[] = [9];
    expect(readPackedSignedVarints(read, into)).toEqual([9, 5, -3, 1]);
  });
});
