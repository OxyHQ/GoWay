/**
 * A failed saved-list call, as the sentence the person should read.
 *
 * The API's `conflict` carries a closed `reason` (`SAVED_LIST_CONFLICT_REASONS`)
 * so "that name is taken" and "you have too many lists" are different
 * sentences, not one "couldn't save".
 */
import {
  GoWayConflictError,
  GoWayForbiddenError,
  MAX_SAVED_LIST_ITEMS,
  MAX_SAVED_LISTS_PER_USER,
  SAVED_LIST_CONFLICT_DETAIL,
} from '@goway.to/sdk';

import { classifyGoWayError } from '@/lib/goway/errors';
import type { MessageValues } from '@/lib/i18n';

type Translate = (key: string, values?: MessageValues) => string;

export function savedFailureMessage(error: unknown, t: Translate): string {
  if (error instanceof GoWayConflictError) {
    const reason = error.details?.[SAVED_LIST_CONFLICT_DETAIL];
    if (reason === 'name_taken') return t('saved.error.nameTaken');
    if (reason === 'list_limit_reached')
      return t('saved.error.listLimit', { max: MAX_SAVED_LISTS_PER_USER });
    if (reason === 'item_limit_reached')
      return t('saved.error.itemLimit', { max: MAX_SAVED_LIST_ITEMS });
  }
  if (error instanceof GoWayForbiddenError) return t('saved.error.forbidden');
  const { kind } = classifyGoWayError(error);
  if (kind === 'gone') return t('saved.error.gone');
  if (kind === 'offline' || kind === 'timeout') return t('saved.error.offline');
  return t('saved.error.generic');
}
