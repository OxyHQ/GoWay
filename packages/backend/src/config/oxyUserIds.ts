/**
 * A comma-separated list of Oxy user ids, as an environment variable carries it.
 *
 * The one parse behind every allow-list GoWay keys on Oxy identity — the closed
 * Street 3D contribution pilot (`CAPTURE_PILOT_OXY_USER_IDS`) and the
 * moderation operators (`MODERATION_OPERATOR_OXY_USER_IDS`) — so the two cannot
 * come to disagree about what an id looks like. Unset or empty is the empty
 * list; a malformed id fails the configuration parse that owns the variable,
 * naming it. Oxy owns identity, so these are foreign ids with nothing in this
 * database to point at.
 */

import { z } from 'zod';

export const oxyUserIdList = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : value,
  z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be Oxy user ids')).default([]),
);
