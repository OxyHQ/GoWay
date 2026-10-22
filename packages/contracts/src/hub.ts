/**
 * What every GoWay Data Hub channel shares on the wire: the credit and
 * licence a client shows while a provider's data is drawn, and the bounded
 * display text a feed supplies. A channel (`live-source.ts`, `cameras.ts`)
 * builds on these rather than restating them.
 */

import { z } from 'zod';

/** Short display text from a feed: trimmed, bounded, never empty. */
export const feedText = (max: number) => z.string().trim().min(1).max(max);

/** A link a client renders as text: a credit or a licence. */
export const hubLinkSchema = z.object({
  label: feedText(120),
  href: z.string().regex(/^https:\/\//, 'must be an https URL'),
});
export type HubLink = z.infer<typeof hubLinkSchema>;
