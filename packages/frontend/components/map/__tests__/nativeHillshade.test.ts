/**
 * The native hillshade's paint reaches MapLibre Native as the wrapper's own
 * camelCase style — answered with the installed wrapper's code, not a guess.
 *
 * PR #124 review suspected the opposite: that spreading the style-spec
 * fragment (kebab-case `paint`) into maplibre-react-native's `<Layer>` loses
 * the colours and the zoom fade, because the wrapper wants a camelCase `style`.
 * In 11.4 `style` is the DEPRECATED prop; `paint`/`layout` are the current API,
 * and `Layer` converts them with `mergeStyleProps` → `convertToInternalStyle`
 * (kebab → camel) before `transformStyle` bridges them to native. This runs
 * that conversion on the real fragment and checks every resulting key is one
 * the native side has a type for.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hillshadeLayer } from '@/lib/map/style/relief';

const WRAPPER = dirname(require.resolve('@maplibre/maplibre-react-native/package.json'));

describe('the native hillshade', () => {
  test('the installed Layer converts style-spec paint itself, and style is the deprecated path', () => {
    const layer = readFileSync(join(WRAPPER, 'src/components/layer/Layer.tsx'), 'utf8');
    expect(layer).toContain('const mergedStyle = mergeStyleProps(');
    expect(layer).toContain('The `style` prop is deprecated');
  });

  test('every paint key becomes a camelCase property the native side knows, values intact', async () => {
    const { mergeStyleProps } = (await import(join(WRAPPER, 'src/utils/convertStyleSpec.ts'))) as {
      mergeStyleProps: (p?: object, l?: object, s?: object) => Record<string, unknown>;
    };
    // Read as text: the module imports React Native, which bun cannot load.
    const known = readFileSync(join(WRAPPER, 'src/utils/getStylePropertyType.ts'), 'utf8');

    for (const appearance of ['light', 'dark'] as const) {
      const paint = hillshadeLayer(appearance).paint ?? {};
      const converted = mergeStyleProps(paint, undefined, undefined);
      expect(Object.keys(converted).length).toBe(Object.keys(paint).length);
      for (const [key, value] of Object.entries(paint)) {
        const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        expect(converted[camel]).toEqual(value);
        expect(known).toContain(`  ${camel}: StyleType.`);
      }
    }
  });
});
