import { z } from 'zod';
import { pageSchema, cursorSchema, limitSchema } from './pagination';
import { placeIdSchema } from './place';

const id = z.string().min(1).max(128);
export const organizationListPathSchema = z.object({ listId: id });
export const organizationListEntryPathSchema = organizationListPathSchema.extend({ entryId: id });
export const organizationListInputSchema = z
  .object({
    oxyAccountId: id,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).default(''),
  })
  .strict();
export const organizationListUpdateSchema = organizationListInputSchema.omit({
  oxyAccountId: true,
});
export const organizationListSchema = organizationListInputSchema.extend({
  id,
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
/** UTC instants are unambiguous across DST. UI displays them in the current place timezone. */
export const organizationListEntryInputSchema = z
  .object({
    placeId: placeIdSchema,
    activity: z.string().trim().min(1).max(160),
    information: z.string().trim().max(4000).default(''),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: 'End must be after start',
    path: ['endsAt'],
  });
export const organizationListEntrySchema = organizationListEntryInputSchema.safeExtend({
  id,
  listId: id,
  position: z.number().int().nonnegative(),
  completedAt: z.iso.datetime().nullable(),
  status: z.enum(['upcoming', 'active', 'expired', 'completed']),
  timezone: z.string().nullable(),
});
export const organizationListPageSchema = pageSchema(organizationListSchema);
export const organizationListEntryPageSchema = pageSchema(organizationListEntrySchema);
export const organizationListQuerySchema = z
  .object({
    oxyAccountId: id.optional(),
    cursor: cursorSchema.optional(),
    limit: limitSchema(50, 20),
  })
  .strict();
export const organizationListEntryQuerySchema = z
  .object({
    state: z.enum(['active', 'all']).default('active'),
    cursor: cursorSchema.optional(),
    limit: limitSchema(50, 20),
  })
  .strict();
export const organizationListOrderInputSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    entryIds: z.array(id).max(200),
  })
  .strict()
  .refine((v) => new Set(v.entryIds).size === v.entryIds.length, {
    message: 'Entry ids must be unique',
  });
export type OrganizationList = z.infer<typeof organizationListSchema>;
export type OrganizationListInput = z.input<typeof organizationListInputSchema>;
export type OrganizationListUpdate = z.input<typeof organizationListUpdateSchema>;
export type OrganizationListEntry = z.infer<typeof organizationListEntrySchema>;
export type OrganizationListEntryInput = z.input<typeof organizationListEntryInputSchema>;
export type OrganizationListQuery = z.input<typeof organizationListQuerySchema>;
export type OrganizationListEntryQuery = z.input<typeof organizationListEntryQuerySchema>;
export type OrganizationListOrderInput = z.input<typeof organizationListOrderInputSchema>;
