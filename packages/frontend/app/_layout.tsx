// Tailwind v4 + NativeWind entry. Importing it here is what makes react-native-css
// compile the utility stylesheet for the web build, so className layout utilities
// (from this app and @oxy.so/services) render on web instead of falling through to
// react-native-web's base View reset. Pairs with postcss.config.mjs.
import '../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OxyProvider } from '@oxy.so/services';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';

import { OXY_CLIENT_ID } from '@/lib/config';
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { THEME_PERSIST_KEY, themeStorage } from '@/lib/themePersistence';
import { LocaleProvider } from '@/lib/i18n';
import { ErrorFallback } from '@/components/error-fallback';

/**
 * Top-level error boundary. expo-router renders this whenever a render error
 * escapes a nested route, so an unexpected crash falls back to a branded retry
 * screen instead of a blank white screen.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}

/**
 * GoWay's root.
 *
 * **There is no auth route group, and that is the product decision.** The
 * scaffolder ships an `AuthRouter` that redirects the whole `(app)` group to
 * `(auth)` until a session resolves; GoWay deletes it, because the map is
 * public (AGENTS.md → Privacy; issues #2 and #7: "browse without signing in",
 * "Do not require location permission to open GoWay"). A route-group swap is
 * the wrong shape for a product whose ENTRY is public and whose private parts
 * are individual ACTIONS — saving a place, editing one, building a list,
 * contributing. Those are gated one at a time by `useAuthGate()`
 * (`lib/authGate.ts`), which opens the in-app Oxy account dialog at the moment
 * the user asks for the thing, rather than in front of the thing they did not.
 *
 * `OxyProvider` remains the single session authority on both platforms, and
 * sign-in remains the in-app `OxyAccountDialog` — never a redirect to an IdP.
 *
 * Provider order, and why:
 *
 *  - `BloomProvider` is ABOVE everything that renders, including any future
 *    splash or loading branch. `useTheme()` throws outside it, and a splash
 *    rendered as a sibling would be a cold-start-only crash that `tsc` and
 *    Jest both pass straight over.
 *  - `PortalProvider`/`PortalOutlet` is mounted here, exactly once. The other
 *    two Bloom outlets are NOT mounted here on purpose: `OxyProvider` already
 *    renders `SurfaceProvider` (which renders `SurfaceHost`) and `ToastOutlet`
 *    internally, and a second mount of either silently duplicates every
 *    surface and every toast.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <BloomProvider
            persistKey={THEME_PERSIST_KEY}
            storage={themeStorage}
            imageResolver={(id, variant) => oxyServices.getFileDownloadUrl(id, variant ?? 'thumb')}
          >
            <OxyProvider
              oxyServices={oxyServices}
              clientId={OXY_CLIENT_ID}
              queryClient={queryClient}
            >
              {/* Renders nothing itself — it pushes to the toast store that
                  OxyProvider's own <ToastOutlet /> renders. */}
              <ConnectionStatusToasts />
              <LocaleProvider>
                <PortalProvider>
                  <Stack screenOptions={{ headerShown: false }} />
                  <StatusBar style="auto" />
                  <PortalOutlet />
                </PortalProvider>
              </LocaleProvider>
            </OxyProvider>
          </BloomProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
