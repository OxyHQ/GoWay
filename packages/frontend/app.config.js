// Dynamic Expo config. A development build can sit next to the production app on
// the same device via APP_VARIANT=development (distinct id + name).
const IS_DEV = process.env.APP_VARIANT === 'development';

const APP_ID = IS_DEV ? 'to.goway.app.dev' : 'to.goway.app';
const APP_NAME = IS_DEV ? 'GoWay (Dev)' : 'GoWay';

// GoWay's icons, rendered from the ONE piece of artwork in
// `components/brand/artwork.ts` — the same geometry the map badge draws, so an
// icon can never be a different logo from the one in the product.
//
// These four are PNG because Expo's image pipeline is PNG: `icon` becomes the
// iOS asset catalogue, `foregroundImage` becomes the Android adaptive layers,
// and both are rasterised at build time from whatever file is named here. The
// web favicon is the exception and gets the SVG as well — see `app/+html.tsx`.
//
// Each is the MARK, never the wordmark, except the splash. Two rows of bubble
// letters do not survive a 60px launcher grid; the note on `GOWAY_MARK` records
// where even the single "G" stops reading, and the sizes below sit well above
// it. The splash has a whole screen, so it gets the full lockup.
//
//  - `icon.png`          1024, opaque white, mark at 70%. iOS forbids alpha and
//                        masks the corners itself, so it is drawn full-bleed.
//  - `adaptive-icon.png` 1024, transparent, mark at 56% — inside Android's
//                        central safe zone, which is all a round, squircle or
//                        squared launcher mask is guaranteed to keep.
//  - `splash-icon.png`   1024x648, transparent, so ONE file works over both
//                        the light and dark splash backgrounds below.
//  - `favicon.png`       64, opaque — a fallback for browsers with no SVG icon.
const ICON = './assets/brand/icon.png';
const ADAPTIVE_ICON = './assets/brand/adaptive-icon.png';
const SPLASH_ICON = './assets/brand/splash-icon.png';
const FAVICON = './assets/brand/favicon.png';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'goway',
    scheme: 'goway',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: ICON,
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
      adaptiveIcon: {
        foregroundImage: ADAPTIVE_ICON,
        // White rather than GoWay blue: the mark's own #004aad outline is what
        // separates it from its surroundings, and on a blue plate that outline
        // vanishes and the "G" becomes a pale blob. Checked by rendering the
        // logo over the eight colours a GoWay map is actually made of before
        // the badge was designed — see `components/map/MapBrand.tsx`.
        backgroundColor: '#ffffff',
      },
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: FAVICON,
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        {
          // ONE image for both appearances. The lockup carries its own heavy
          // outline, so it reads unchanged on the near-white and the near-black
          // background; rendered over both before this was committed rather
          // than assumed. That is also why there is no `dark.image`.
          image: SPLASH_ICON,
          imageWidth: 240,
          resizeMode: 'contain',
          backgroundColor: '#faf1f6',
          dark: { image: SPLASH_ICON, backgroundColor: '#100d10' },
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
