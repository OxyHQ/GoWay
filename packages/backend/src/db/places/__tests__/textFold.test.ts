import { describe, expect, it } from 'bun:test';
import { FOLD_TABLE, foldText } from '../textFold';

describe('foldText', () => {
  it('lower-cases, trims and strips accents', () => {
    expect(foldText('  Café SAGRADA ')).toBe('cafe sagrada');
    expect(foldText('Peñíscola')).toBe('peniscola');
    expect(foldText('München')).toBe('munchen');
    expect(foldText('Ёлка')).toBe('елка');
  });

  it('is the same for composed and decomposed input', () => {
    expect(foldText('Café')).toBe(foldText('Café'));
  });

  it('leaves letters that are not accented forms alone', () => {
    expect(foldText('Ørsted')).toBe('ørsted');
  });
});

describe('the fold table', () => {
  it('maps one character to one character', () => {
    expect([...FOLD_TABLE.from].length).toBe([...FOLD_TABLE.to].length);
  });

  // The deployed `*_name_fold_trgm_idx` indexes are built on
  // `translate(name_normalized, from, to)`. Changing the table makes every query
  // miss them: a new table needs a new index first, then a new hash here.
  it('is the table the deployed indexes were built on', () => {
    const digest = new Bun.CryptoHasher('sha256')
      .update(`${FOLD_TABLE.from}|${FOLD_TABLE.to}`)
      .digest('hex');
    expect(digest).toBe('d3ba62445d930ebea953438f32df88d366cd2183c03f6863c6b2a303eb8b2deb');
    expect([...FOLD_TABLE.from].length).toBe(411);
  });
});
