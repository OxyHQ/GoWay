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
      // Shared Oxy native config: android:sharedUserId, iOS keychain group,
      // expo-build-properties defaults, and the shared-identity reader.
      ['@oxy.so/app-preset', {}],
    ],
    extra: {
      router: {},
    },
  },
};
