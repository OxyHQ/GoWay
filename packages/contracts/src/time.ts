/**
 * Instants on the wire: ISO 8601 strings, UTC as GoWay writes them.
 *
 * Checked with `Date.parse` rather than a pattern alone, because the spelling
 * is not what matters downstream — whether the value survives the trip into a
 * `timestamptz` (or a consumer's `new Date`) is. A string that parses to `NaN`
 * would otherwise be stored or rendered as an invalid date and fail far from
 * the field that carried it.
 */

import { z } from 'zod';

/** An ISO 8601 instant that actually parses. */
export const instantSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 instant')
  .meta({ format: 'date-time' });
