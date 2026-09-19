// Dynamic Expo config. A development build can sit next to the production app on
// the same device via APP_VARIANT=development (distinct id + name).
const IS_DEV = process.env.APP_VARIANT === 'development';

const APP_ID = IS_DEV ? 'to.goway.app.dev' : 'to.goway.app';
const APP_NAME = IS_DEV ? 'GoWay (Dev)' : 'GoWay';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'goway',
    scheme: 'goway',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
    },
    android: {
      package: APP_ID,
    },
    web: {
      bundler: 'metro',
      output: 'single',
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        {
          backgroundColor: '#faf1f6',
          dark: { backgroundColor: '#100d10' },
        },
      ],
      // MapLibre Native — the iOS/Android map renderer behind
      // `components/map/MapCanvas.native.tsx`.
      //
      // THIS IS WHAT MAKES GOWAY REQUIRE A DEVELOPMENT BUILD. The plugin adds
      // the `org.maplibre.gl` Android artifacts and the MapLibre Swift package
      // to the generated projects, so the native module exists only in a build
      // that ran prebuild + compile. **Expo Go cannot run GoWay** — it ships a
      // fixed set of native modules and MapLibre is not among them, and the
      // failure is a runtime "view manager not found", not a build error. See
      // README.md → "Native builds".
      //
      // `locationEngine` stays on MapLibre's default rather than Google Play
      // Services: the default keeps the Android build F-Droid-compatible and
      // GoWay does not need sub-metre fusion to centre a map.
      ['@maplibre/maplibre-react-native', {}],
      // Location is requested CONTEXTUALLY (see `lib/map/useUserLocation.ts`),
      // never at launch. These strings are what iOS shows in that prompt, so
      // they say why at the moment the user asked — matching the in-app hint.
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'GoWay uses your location to centre the map on you and to give you directions from where you are. It is never stored.',
          // GoWay has no background-location feature and must not ask for one.
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
        },
      ],
      // Shared Oxy native config: android:sharedUserId, iOS keychain group,
      // expo-build-properties defaults, and the shared-identity reader.
      ['@oxy.so/app-preset', {}],
    ],
    extra: {
      router: {},
    },
  },
};
