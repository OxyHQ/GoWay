/**
 * A small, bounded XML reader for the flat, regular documents feeds publish
 * (SIRI-VM, a camera list): elements with text content and no mixed nesting.
 * The backend has no XML parser and these documents do not need a DOM. It is
 * not for arbitrary XML; a feed that needs namespaces resolved or attributes
 * read through a schema is not what this is for.
 */

/** The first `<Name>…</Name>` (any namespace prefix) inside `xml`, decoded and trimmed. */
export function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`).exec(xml);
  return match ? decodeXml((match[1] ?? '').trim()) : null;
}

/** The inner XML of every `<Name>…</Name>` (any namespace prefix) in `xml`, in order. */
export function elements(xml: string, name: string): string[] {
  const pattern = new RegExp(
    `<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`,
    'g',
  );
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '');
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
