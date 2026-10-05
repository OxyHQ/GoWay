/**
 * Query strings, read by the same schema that types them.
 *
 * Every GoWay query schema is written in VALUE form — `latitude` is a number,
 * `capabilities` is an array — because that is the shape an SDK caller passes
 * and the shape the OpenAPI document publishes. A query string carries only
 * strings, so the server reads one through {@link queryValues}, which converts
 * each parameter by the TYPE its own schema declares and nothing else. There is
 * no second, string-typed copy of any query schema to drift from the first.
 *
 * The encoding is the one `@goway.to/sdk` sends:
 *
 * - a number or a boolean is its decimal / `true` / `false` spelling;
 * - a list is ONE parameter, comma-joined (`capabilities=a.b,c.d`) — a
 *   repeated parameter is refused upstream as `bad_request`;
 * - an empty value is the same as an absent one.
 *
 * A parameter the schema does not declare is passed through untouched, so the
 * schema's own `.strict()` is what refuses it.
 */

import type { z } from 'zod';

type QueryKind = 'number' | 'boolean' | 'array' | 'string';

interface SchemaDefinition {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
}

/** What a field is made of once optional/default/transform wrappers are peeled. */
function kindOf(schema: z.ZodType): QueryKind {
  let current = schema;
  for (;;) {
    const definition = (current as unknown as { def: SchemaDefinition }).def;
    if (definition.innerType) {
      current = definition.innerType;
    } else if (definition.type === 'pipe' && definition.in) {
      current = definition.in;
    } else if (definition.type === 'number' || definition.type === 'boolean' || definition.type === 'array') {
      return definition.type;
    } else {
      return 'string';
    }
  }
}

function convert(kind: QueryKind, value: string): unknown {
  switch (kind) {
    case 'number':
      // `Number('abc')` is NaN, which the schema refuses as a value — the
      // conversion never decides validity itself.
      return Number(value);
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value;
    case 'array': {
      const members = value
        .split(',')
        .map((member) => member.trim())
        .filter((member) => member.length > 0);
      return members.length === 0 ? undefined : [...new Set(members)];
    }
    case 'string':
      return value;
  }
}

/**
 * The typed values of a single-valued query string, ready for `schema`.
 *
 * `raw` must already be single-valued (one string per name); refusing a
 * repeated parameter is the caller's job, because it is `bad_request` and not a
 * question this function can answer by converting.
 */
export function queryValues(schema: z.ZodObject, raw: Readonly<Record<string, string>>): Record<string, unknown> {
  const shape = schema.shape as Record<string, z.ZodType>;
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value.trim().length === 0) continue;
    const field = shape[name];
    values[name] = field === undefined ? value : convert(kindOf(field), value);
  }
  return values;
}
