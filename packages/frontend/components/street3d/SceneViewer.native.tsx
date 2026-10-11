/**
 * `SceneViewer`, native — the web viewer, hosted in a WebView.
 *
 * ## Why a WebView, and why only for now
 *
 * #14 Phase F asks that the FINAL native renderer be chosen from benchmarks on
 * real devices, not assumed. A native Gaussian renderer is a large commitment
 * (a GPU sort, a decoder, two platform ports) and the candidates differ most in
 * exactly what has not been measured yet: sort cost and memory on mid-range
 * phones. So the initial native strategy is the cheapest correct one — the
 * SAME viewer the web ships, loaded from GoWay's own web origin in
 * `?embed=1` mode — which gives native users the feature today, gives the
 * benchmark a baseline, and locks in nothing. Replacing this file with a
 * native renderer changes no screen: the props are `SceneViewerProps`.
 *
 * ## What the WebView may do
 *
 *  - Load GoWay's web origin (`WEB_ORIGIN`) and nothing else. A navigation
 *    anywhere else is refused; the page has no reason to leave.
 *  - Talk back over a tiny, validated protocol (`bridge.ts`): a place tap and
 *    the viewer phase. A place tap becomes NATIVE navigation, so the place
 *    page is the app's own, with its own back stack.
 *  - Never ask for location: geolocation is off in the WebView outright.
 *
 * The page is public and needs no session, so no token is ever injected into
 * it; reporting and contributing are native controls on the native screen.
 */
import { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { WEB_ORIGIN } from '@/lib/config';

import { embedUrl, isOnOrigin, parseBridgeMessage } from './bridge';
import type { SceneViewerProps } from './types';

function SceneViewerComponent({
  manifest,
  onLabelPress,
  onPhaseChange,
  style,
  testID,
}: SceneViewerProps) {
  const source = useMemo(() => ({ uri: embedUrl(WEB_ORIGIN, manifest.id) }), [manifest.id]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseBridgeMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === 'place') onLabelPress?.(message.placeId);
      else onPhaseChange?.(message.phase);
    },
    [onLabelPress, onPhaseChange],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (request: { url: string }) =>
      isOnOrigin(request.url, WEB_ORIGIN) || request.url === 'about:blank',
    [],
  );

  return (
    <View style={style} className="flex-1 overflow-hidden" testID={testID}>
      <WebView
        source={source}
        originWhitelist={[WEB_ORIGIN]}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onMessage={onMessage}
        onError={() => onPhaseChange?.('error')}
        onHttpError={() => onPhaseChange?.('error')}
        javaScriptEnabled
        geolocationEnabled={false}
        allowFileAccess={false}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction
        // The poster on the native screen covers the boot; a transparent
        // WebView lets it show through until the page draws.
        style={{ flex: 1, backgroundColor: 'transparent' }}
        containerStyle={{ backgroundColor: 'transparent' }}
      />
    </View>
  );
}

export const SceneViewer = memo(SceneViewerComponent);
