/**
 * Every gesture callback in the app is a worklet once the app's own Babel
 * config has compiled it, for native and for web.
 *
 * Born of the dev error toast "[react-native-gesture-handler] Some of the
 * callbacks in the gesture are worklets and some are not": the map sheet's body
 * pan chained its touch callbacks off a VARIABLE (`gated.onTouchesDown(…)`),
 * and the worklets Babel plugin only workletizes a callback chained straight
 * off `Gesture.Pan()`. RNGH logs that error on every attach in a development
 * build, and — because a gesture runs on the UI thread only when every
 * callback is a worklet — drove the whole body drag from the JS thread on
 * native, in every build, with nothing in production to say so.
 *
 * This compiles each file that imports `react-native-gesture-handler` exactly
 * as Metro does (`babel.config.js`, worklets plugin last) and requires every
 * `on…` gesture callback to come out as a worklet, unless its chain says
 * `.runOnJS(true)` — the one explicit way to run a gesture on the JS thread.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';

import { SOURCE_FILES } from './sourceScan';

const FRONTEND = join(import.meta.dir, '..', '..');

/**
 * The `@babel/core` Metro transforms with: `@expo/metro-config`'s own, reached
 * through `expo` as Metro reaches it (the app declares neither babel nor the
 * config directly). Untyped here; this is all of it the test uses.
 */
const fromExpo = createRequire(createRequire(join(FRONTEND, 'package.json')).resolve('expo'));
const babel = createRequire(fromExpo.resolve('@expo/metro-config'))('@babel/core') as {
  transformSync(code: string, options: Record<string, unknown>): { code?: string | null } | null;
};

/** RNGH's gesture callbacks (`CALLBACK_TYPE`), the ones its worklet check reads. */
const CALLBACKS = new Set([
  'onBegin',
  'onStart',
  'onUpdate',
  'onChange',
  'onEnd',
  'onFinalize',
  'onTouchesDown',
  'onTouchesMove',
  'onTouchesUp',
  'onTouchesCancelled',
]);

const PLATFORMS = ['ios', 'android', 'web'] as const;

function compile(code: string, filename: string, platform: string): string {
  const out = babel.transformSync(code, {
    filename,
    cwd: FRONTEND,
    root: FRONTEND,
    configFile: join(FRONTEND, 'babel.config.js'),
    caller: { name: 'metro', bundler: 'metro', platform, isDev: true },
  });
  if (!out?.code) throw new Error(`babel produced nothing for ${filename} (${platform})`);
  return out.code;
}

/** `….runOnJS(true)` anywhere up the builder chain this callback hangs off. */
function chainRunsOnJS(node: ts.Expression): boolean {
  let at: ts.Expression = node;
  while (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression)) {
    if (
      at.expression.name.text === 'runOnJS' &&
      at.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
    ) {
      return true;
    }
    at = at.expression.expression;
  }
  return false;
}

/**
 * The gesture callbacks in compiled `code` that are not worklets: the
 * worklets plugin stamps each worklet it makes with `__workletHash`.
 */
function plainCallbacks(code: string): string[] {
  const file = ts.createSourceFile('compiled.js', code, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CALLBACKS.has(node.expression.name.text)
    ) {
      const callback = node.arguments[0];
      if (
        callback &&
        !callback.getText(file).includes('__workletHash') &&
        !chainRunsOnJS(node.expression.expression)
      ) {
        found.push(
          `.${node.expression.name.text}(${callback.getText(file).replace(/\s+/g, ' ').slice(0, 60)}…)`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the checker', () => {
  // The worklets plugin reads the file it compiles for its source maps, so a
  // snippet is compiled under a path that exists: this test's own.
  const fixture = import.meta.path;
  const check = (body: string) =>
    PLATFORMS.flatMap((platform) =>
      plainCallbacks(
        compile(
          `import { Gesture } from 'react-native-gesture-handler';\nconst shared = { value: 0 };\n${body}`,
          fixture,
          platform,
        ),
      ),
    );

  test('passes callbacks chained straight off Gesture.Pan()', () => {
    expect(check('export const pan = Gesture.Pan().onStart(() => { shared.value = 1; });')).toEqual(
      [],
    );
  });

  test("fails a callback chained off a variable without 'worklet' (the map sheet's bug)", () => {
    const found = check(
      [
        'const pan = Gesture.Pan().onStart(() => { shared.value = 1; });',
        'export const gated = pan.manualActivation(true).onTouchesDown(() => { shared.value = 2; });',
      ].join('\n'),
    );
    expect(found).toHaveLength(PLATFORMS.length);
    for (const hit of found) expect(hit).toStartWith('.onTouchesDown(');
  });

  test("passes the same callback once it says 'worklet'", () => {
    expect(
      check(
        [
          'const pan = Gesture.Pan().onStart(() => { shared.value = 1; });',
          "export const gated = pan.manualActivation(true).onTouchesDown(() => { 'worklet'; shared.value = 2; });",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('passes a gesture that runs on the JS thread on purpose', () => {
    expect(
      check(
        [
          'const pan = Gesture.Pan();',
          'export const onJs = pan.runOnJS(true).onTouchesDown(() => { shared.value = 2; });',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('every gesture callback in the app is a worklet', () => {
  const gestureFiles = SOURCE_FILES.filter(({ text }) =>
    text.includes("from 'react-native-gesture-handler'"),
  );

  test('the scan sees the gesture code (the map sheet, at least)', () => {
    expect(gestureFiles.map(({ path }) => path)).toContain(
      join('components', 'sheet', 'MapSheet.tsx'),
    );
  });

  for (const { path, text } of gestureFiles) {
    for (const platform of PLATFORMS) {
      test(`${path} (${platform})`, () => {
        expect(plainCallbacks(compile(text, join(FRONTEND, path), platform))).toEqual([]);
      });
    }
  }
});
