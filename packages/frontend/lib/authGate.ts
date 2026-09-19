/**
 * Per-FEATURE authentication, which is the only kind GoWay has.
 *
 * The map, search and routing are public (AGENTS.md → Privacy; issue #7 →
 * "Authentication boundary"). Identity is required only by things that are
 * *about* a person: private saves, authored edits, lists, account-linked
 * contributions. So there is no auth route group and no redirect — a gated
 * action calls `run()`, and if there is no session the in-app Oxy account
 * dialog opens over the map instead of replacing it.
 *
 * Three properties this shape buys, in order of how easy they are to lose:
 *
 *  - The user never loses their place. The map, the camera, the selected place
 *    and the sheet are all still mounted behind the dialog.
 *  - Nothing is gated by accident. A screen that forgets to call `run()` fails
 *    at the API, where `canUsePrivateApi` is checked, not by rendering a login
 *    wall in front of public content.
 *  - Sign-in stays the in-app `OxyAccountDialog`, never a redirect to an IdP.
 */
import { useCallback } from 'react';
import { useOxy } from '@oxy.so/services';

export interface AuthGate {
  /** Whether a private (identity-bound) API call may be made right now. */
  canUsePrivateApi: boolean;
  /** Whether the session is still resolving on cold boot. */
  isPending: boolean;
  /**
   * Run `action` if the user is signed in; otherwise open the Oxy account
   * dialog and do nothing else.
   *
   * Returns `true` when the action ran. It deliberately does NOT queue the
   * action to replay after sign-in: a tap that silently fires minutes later,
   * against a map that has since moved, is worse than asking again.
   */
  run: (action: () => void) => boolean;
}

export function useAuthGate(): AuthGate {
  const { canUsePrivateApi, isPrivateApiPending, openAccountDialog } = useOxy();

  const run = useCallback(
    (action: () => void) => {
      if (canUsePrivateApi) {
        action();
        return true;
      }
      openAccountDialog();
      return false;
    },
    [canUsePrivateApi, openAccountDialog],
  );

  return { canUsePrivateApi, isPending: isPrivateApiPending, run };
}
