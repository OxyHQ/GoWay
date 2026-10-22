import { describe, expect, it } from 'bun:test';
import { decodeXml, elements, tag } from '../xml';

describe('tag', () => {
  it('reads the first element, with or without a namespace prefix, decoded and trimmed', () => {
    expect(tag('<a><n:Name> Plaza &amp; Co </n:Name></a>', 'Name')).toBe('Plaza & Co');
    expect(tag('<Name id="1">x</Name><Name>y</Name>', 'Name')).toBe('x');
    expect(tag('<a/>', 'Name')).toBeNull();
  });

  it('does not match a longer tag name', () => {
    expect(tag('<NameTwo>no</NameTwo>', 'Name')).toBeNull();
  });
});

describe('elements', () => {
  it('returns the inner XML of every occurrence in order', () => {
    const xml = '<list><item><k>1</k></item><item a="b"><k>2</k></item></list>';
    expect(elements(xml, 'item').map((inner) => tag(inner, 'k'))).toEqual(['1', '2']);
    expect(elements(xml, 'missing')).toEqual([]);
  });
});

describe('decodeXml', () => {
  it('decodes the five predefined entities, ampersand last', () => {
    expect(decodeXml('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;amp;')).toBe(
      '<a> "b" \'c\' &amp;',
    );
  });
});
