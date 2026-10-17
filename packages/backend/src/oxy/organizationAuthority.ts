import { ApiError } from '../http/apiError';
import { type OxyCaller, readCallerAccount } from './accountRoles';

/** The roles that may write an organization's lists. */
const LIST_EDITOR_ROLES: readonly string[] = ['owner', 'admin', 'editor'];

/**
 * May this caller write lists for that organization? Throws when not.
 *
 * Asked of Oxy's live account graph on every call — no member cache, so a
 * removed editor loses access at once — through the one Oxy client and error
 * mapping in `accountRoles.ts`. Only an ACTIVE membership counts, never the
 * session's own account: a list belongs to an organization, not a person.
 */
export type OrganizationAuthority = (caller: OxyCaller, accountId: string) => Promise<void>;

export function createOrganizationAuthority(oxyApiUrl: string): OrganizationAuthority {
  return async (caller, accountId) => {
    const account = await readCallerAccount(oxyApiUrl, caller, accountId);
    const member = account?.callerMembership;
    if (
      account?.kind !== 'organization' ||
      !member ||
      member.status !== 'active' ||
      !LIST_EDITOR_ROLES.includes(member.role)
    ) {
      throw new ApiError(
        'forbidden',
        'An active organization owner, administrator or editor is required.',
      );
    }
  };
}
