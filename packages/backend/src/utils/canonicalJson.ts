/**
 * JSON with every object's keys sorted, so two equal values serialize to the
 * same bytes whatever order their keys were written in — what a digest over a
 * JSON value needs to mean "the same value" rather than "the same spelling".
 *
 * Arrays keep their order: order is part of an array's value.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}
