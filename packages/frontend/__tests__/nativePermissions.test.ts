/**
 * The native permissions GoWay's own dependencies bring in, and the ones it refuses.
 *
 * `expo-sensors` (the guided capture's DeviceMotion) ships a library manifest
 * declaring `android.permission.ACTIVITY_RECOGNITION` for its Pedometer, and
 * Gradle merges that into the app unless the app's own manifest removes it.
 * GoWay never counts steps, so `app.config.js` blocks it. Nothing at runtime
 * would notice the block disappearing — the permission is never requested, so
 * no prompt and no failure — only the app's permission list in Android
 * settings and the store listing would grow "Physical activity" again.
 *
 * ## The instrument
 *
 * `expo config --type introspect`: Expo's own CLI, running every config plugin
 * against the real `app.config.js` and returning the AndroidManifest and
 * Info.plist prebuild would write, without writing anything. The Gradle merge
 * itself is not run here (it needs an Android SDK); the `tools:node="remove"`
 * entry asserted below is what the merger honours, measured once on a
 * prebuild into a scratch directory (`processDebugMainManifest`: the merged
 * manifest lost ACTIVITY_RECOGNITION and nothing else).
 *
 * The positive controls prove the scan reads the same lists it checks: a
 * permission GoWay does declare (fine location) must be seen as declared, and
 * the plist must carry the location string `app.config.js` sets.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const EXPO_CLI = require.resolve('expo/bin/cli', { paths: [PROJECT_ROOT] });

interface ManifestPermission {
  $: { 'android:name': string; 'tools:node'?: string };
}

interface Introspected {
  _internal: {
    modResults: {
      android: { manifest: { manifest: { 'uses-permission'?: ManifestPermission[] } } };
      ios: { infoPlist: Record<string, unknown> };
    };
  };
}

function introspect(): Introspected {
  const out = execFileSync(
    process.execPath,
    [EXPO_CLI, 'config', '--type', 'introspect', '--json'],
    // CI is set so the CLI never prompts; stderr is Expo's own chatter.
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return JSON.parse(out) as Introspected;
}

const config = introspect();
const permissions = config._internal.modResults.android.manifest.manifest['uses-permission'] ?? [];
const infoPlist = config._internal.modResults.ios.infoPlist;

const entriesFor = (name: string) => permissions.filter((p) => p.$['android:name'] === name);

describe('Android permissions the app manifest refuses', () => {
  test('the scan sees the permissions GoWay does declare', () => {
    // Vacuity floor + positive control: an empty or unread list would make
    // every "is removed" assertion below meaningless.
    expect(permissions.length).toBeGreaterThan(3);
    const fine = entriesFor('android.permission.ACCESS_FINE_LOCATION');
    expect(fine).toHaveLength(1);
    expect(fine[0]?.$['tools:node']).toBeUndefined();
  });

  test('ACTIVITY_RECOGNITION (expo-sensors Pedometer) is removed, never declared', () => {
    const entries = entriesFor('android.permission.ACTIVITY_RECOGNITION');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.$['tools:node']).toBe('remove');
  });
});

describe('iOS motion purpose string', () => {
  test('the scan reads the plist app.config.js writes', () => {
    expect(String(infoPlist.NSLocationWhenInUseUsageDescription)).toStartWith(
      'GoWay uses your location',
    );
  });

  test("NSMotionUsageDescription is GoWay's own, not Expo's generic default", () => {
    // Kept on purpose (the prebuilt ExpoSensors binary links the pedometer;
    // see app.config.js), but it must say what GoWay actually does.
    const motion = String(infoPlist.NSMotionUsageDescription ?? '');
    expect(motion).toStartWith('GoWay ');
    expect(motion).not.toContain('$(PRODUCT_NAME)');
  });
});
