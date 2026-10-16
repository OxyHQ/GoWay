import {
  organizationListPathSchema,
  organizationListEntryPathSchema,
  organizationListQuerySchema,
  organizationListEntryQuerySchema,
  organizationListInputSchema,
  organizationListUpdateSchema,
  organizationListEntryInputSchema,
  organizationListOrderInputSchema,
  organizationListSchema,
  organizationListPageSchema,
  organizationListEntrySchema,
  organizationListEntryPageSchema,
  type OrganizationListInput,
  type OrganizationListUpdate,
  type OrganizationListEntryInput,
  type OrganizationListQuery,
  type OrganizationListEntryQuery,
  type OrganizationListOrderInput,
} from './contract';
import { request, type TransportConfig } from './transport';
import type { GoWayRequestOptions } from './client';
import { validInput } from './validate';
import { iterateGoWayPages } from './pagination';

export function createOrganizationListsApi(config: TransportConfig) {
  const path = (listId: string) =>
    `/organization-lists/${encodeURIComponent(validInput(organizationListPathSchema, { listId }, 'path').listId)}`;
  const entryPath = (listId: string, entryId: string) => {
    const parsed = validInput(organizationListEntryPathSchema, { listId, entryId }, 'path');
    return `${path(parsed.listId)}/entries/${encodeURIComponent(parsed.entryId)}`;
  };
  const api = {
    list: (query: OrganizationListQuery = {}, options: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/organization-lists',
          query: validInput(organizationListQuerySchema, query, 'query'),
          signal: options.signal,
        },
        organizationListPageSchema,
      ),
    get: (listId: string, options: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: path(listId), signal: options.signal },
        organizationListSchema,
      ),
    create: (input: OrganizationListInput, options: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: '/organization-lists',
          body: validInput(organizationListInputSchema, input, 'input'),
          signal: options.signal,
        },
        organizationListSchema,
      ),
    update: (listId: string, input: OrganizationListUpdate, options: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'PUT',
          path: path(listId),
          body: validInput(organizationListUpdateSchema, input, 'input'),
          signal: options.signal,
        },
        organizationListSchema,
      ),
    delete: (listId: string, options: GoWayRequestOptions = {}) =>
      request(config, { method: 'DELETE', path: path(listId), signal: options.signal }, null),
    entries: (
      listId: string,
      query: OrganizationListEntryQuery = {},
      options: GoWayRequestOptions = {},
    ) =>
      request(
        config,
        {
          method: 'GET',
          path: `${path(listId)}/entries`,
          query: validInput(organizationListEntryQuerySchema, query, 'query'),
          signal: options.signal,
        },
        organizationListEntryPageSchema,
      ),
    addEntry: (
      listId: string,
      input: OrganizationListEntryInput,
      options: GoWayRequestOptions = {},
    ) =>
      request(
        config,
        {
          method: 'POST',
          path: `${path(listId)}/entries`,
          body: validInput(organizationListEntryInputSchema, input, 'input'),
          signal: options.signal,
        },
        organizationListEntrySchema,
      ),
    updateEntry: (
      listId: string,
      entryId: string,
      input: OrganizationListEntryInput,
      options: GoWayRequestOptions = {},
    ) =>
      request(
        config,
        {
          method: 'PUT',
          path: entryPath(listId, entryId),
          body: validInput(organizationListEntryInputSchema, input, 'input'),
          signal: options.signal,
        },
        organizationListEntrySchema,
      ),
    completeEntry: (listId: string, entryId: string, options: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'POST', path: `${entryPath(listId, entryId)}/complete`, signal: options.signal },
        organizationListEntrySchema,
      ),
    deleteEntry: (listId: string, entryId: string, options: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'DELETE', path: entryPath(listId, entryId), signal: options.signal },
        null,
      ),
    order: (listId: string, input: OrganizationListOrderInput, options: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'PUT',
          path: `${path(listId)}/order`,
          body: validInput(organizationListOrderInputSchema, input, 'input'),
          signal: options.signal,
        },
        organizationListSchema,
      ),
  };
  return Object.freeze({
    ...api,
    iterate: (
      query: Omit<OrganizationListQuery, 'cursor'> = {},
      options: GoWayRequestOptions = {},
    ) =>
      iterateGoWayPages((cursor) => api.list({ ...query, ...(cursor ? { cursor } : {}) }, options)),
    iterateEntries: (
      listId: string,
      query: Omit<OrganizationListEntryQuery, 'cursor'> = {},
      options: GoWayRequestOptions = {},
    ) =>
      iterateGoWayPages((cursor) =>
        api.entries(listId, { ...query, ...(cursor ? { cursor } : {}) }, options),
      ),
  });
}
export type GoWayOrganizationListsApi = ReturnType<typeof createOrganizationListsApi>;
