/** Exercise the native onLayout handler without loading a native runtime. */
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

let shared: { set: (value: unknown) => void } | null = null;
const element = (type: unknown, props: unknown) => ({ type, props });
mock.module('react', () => ({
  memo: (value: unknown) => value,
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void) => effect(),
  useCallback: (value: unknown) => value,
}));
mock.module('react/jsx-runtime', () => ({ jsx: element, jsxs: element, Fragment: 'Fragment' }));
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: element, Fragment: 'Fragment' }));
mock.module('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Linking: { openURL: async () => {} },
  Platform: {
    OS: 'android',
    select: (value: { android?: unknown; default?: unknown }) => value.android ?? value.default,
  },
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
}));
mock.module('react-native-reanimated', () => ({
  withTiming: (height: number, options: unknown) => ({ height, options }),
}));
mock.module('@goway.to/sdk/map', () => ({ localizedLabel: () => 'Credit' }));
mock.module('@oxy.so/bloom/locale', () => ({ useBloomLocale: () => 'en' }));
mock.module('@oxy.so/bloom/layout', () => ({ useBottomEdgeInset: () => 0 }));
mock.module('@oxy.so/bloom/icons/RiInformationLine', () => ({ RiInformationLine: 'Icon' }));
mock.module('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { text: 'black', textSecondary: 'gray', card: 'white' } }),
}));
mock.module('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
mock.module('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
const src = resolve(import.meta.dir, '../../src');
mock.module(resolve(src, 'brand/BrandedChrome.tsx'), () => ({ useBrandedChrome: () => false }));
mock.module(resolve(src, 'chromeLift.ts'), () => ({ useMapChromeLift: () => null }));
mock.module(resolve(src, 'creditHeight.ts'), () => ({ useMapCreditHeight: () => shared }));
mock.module(resolve(src, 'LiftedBox.tsx'), () => ({ LiftedBox: 'LiftedBox' }));
mock.module(resolve(src, 'MapBrand.tsx'), () => ({ MAP_BRAND_CLEARANCE: 92 }));

const { MapAttribution } = await import('../../src/MapAttribution');
type FakeElement = {
  type?: unknown;
  props: {
    testID?: string;
    children?: FakeElement | FakeElement[];
    onLayout?: (event: unknown) => void;
    style?: unknown;
    hitSlop?: unknown;
  };
};
const walkElements = (value: unknown): FakeElement[] => {
  if (Array.isArray(value)) return value.flatMap(walkElements);
  if (!value || typeof value !== 'object' || !('props' in value) || !('type' in value)) return [];
  const current = value as FakeElement;
  return [current, ...walkElements(current.props.children)];
};
const local: number[] = [];
let lastTree = {} as FakeElement;
const render = () => {
  lastTree = (MapAttribution as unknown as (props: unknown) => FakeElement)({
    expanded: true,
    onToggle: () => {},
    onHeightChange: (height: number) => local.push(height),
  });
  const plate = lastTree.props.children as FakeElement;
  assert.equal(plate?.props.testID, 'map-credit');
  assert.equal(typeof plate.props.onLayout, 'function');
  return (height: number) => plate.props.onLayout?.({ nativeEvent: { layout: { height } } });
};

const withoutProvider = render();
const androidButtons = walkElements(lastTree).filter((element) => element.type === 'Button');
assert.ok(androidButtons.length >= 2);
for (const button of androidButtons) {
  assert.deepEqual(button.props.style, { minHeight: 48, minWidth: 48 });
  assert.equal(button.props.hitSlop, 0);
}
assert.deepEqual(local, []); // The credit is present before the first measurement.
withoutProvider(62);
assert.deepEqual(local, [62]);
local.length = 0;
const animated: unknown[] = [];
shared = { set: (value) => animated.push(value) };
const withProvider = render();
for (const height of [62, 26, 62, Number.NaN, -1]) withProvider(height);
assert.deepEqual(local, [62, 26, 62]);
assert.deepEqual(
  animated,
  [62, 26, 62].map((height) => ({ height, options: { duration: 160 } })),
);
