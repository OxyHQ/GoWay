import { OxyServices, OxyApiError } from '@oxy.so/core';
import { ApiError } from '../http/apiError';
import type { OxyCaller } from './accountRoles';

/** Each mutation checks the live organization graph, including switched sessions. No member cache. */
export type OrganizationAuthority = (caller: OxyCaller, accountId: string) => Promise<void>;
export function createOrganizationAuthority(oxyApiUrl: string): OrganizationAuthority {
  return async (caller, accountId) => {
    if (!caller.accessToken) throw new ApiError('unauthorized', 'An Oxy session is required.');
    const oxy = new OxyServices({
      baseURL: oxyApiUrl,
      enableCache: false,
      enableRetry: false,
      requestTimeout: 5000,
    });
    oxy.session.setAccessToken(caller.accessToken);
    try {
      const account = await oxy.accounts.get(accountId);
      const member = account.callerMembership;
      if (
        account.kind !== 'organization' ||
        !member ||
        member.status !== 'active' ||
        !['owner', 'admin', 'editor'].includes(member.role)
      ) {
        throw new ApiError(
          'forbidden',
          'An active organization owner, administrator or editor is required.',
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof OxyApiError && error.status === 401)
        throw new ApiError('unauthorized', 'The Oxy session is no longer valid.');
      if (error instanceof OxyApiError && [403, 404].includes(error.status ?? 0))
        throw new ApiError('forbidden', 'Organization access is required.');
      throw new ApiError(
        'service_unavailable',
        'Organization access cannot be checked. Try again shortly.',
      );
    } finally {
      oxy.dispose();
    }
  };
}
