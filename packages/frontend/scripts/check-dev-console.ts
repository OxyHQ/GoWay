/**
 * THE DEVELOPMENT CONSOLE GATE: the real app, a development build, opened at
 * phone size and driven through its main surfaces, must leave nothing from the
 * gesture and animation stack in the console and throw nothing uncaught.
 *
 *   bun run --cwd packages/frontend export:web --dev --output-dir /tmp/dev-console
 *   bun run --cwd packages/frontend check:dev-console --dist=/tmp/dev-console
 *
 * or, against a running `expo start --web`: `check:dev-console --url=http://localhost:8081`.
 *
 * Born of the dev error toast "[react-native-gesture-handler] Some of the
 * callbacks in the gesture are worklets and some are not": the map sheet's
 * body pan, a gesture whose touch callbacks were plain functions beside
 * worklets. React Native Gesture Handler, Reanimated and Worklets only say so
 * in a development build, at runtime, when the gesture is attached — no type,
 * test or production build sees it. `gestureWorklets.test.ts` holds the app's
 * own gesture code to the rule that broke; this holds the RUNNING app, Bloom's
 * sheets and dialogs included, to the whole stack's word.
 *
 * ## What it drives
 *
 * A 390×844 touch viewport (the map sheet, not the desktop side panel):
 * load; open map settings and the map style picker, each closed with Escape;
 * drag the sheet up by its body (the body pan, with its manual activation) and
 * down by its handle; tap the handle; open a place from the list and come
 * back. Each surface must appear and each drag must move the sheet, so a gate
 * that opened nothing fails instead of passing quietly. (The account dialog
 * needs a registered client id, which an export for this gate does not hold.)
 * Fixtures answer places (a development build); every request off the page's
 * own origin is refused.
 *
 * ## What it asserts
 *
 *  - No console message, at any level, from `[react-native-gesture-handler]`,
 *    `[Reanimated]` or `[Worklets]`.
 *  - No uncaught error (`pageerror`).
 *
 * Every other console error is printed, not judged: it is not this gate's.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

import { serveDevExport } from './serveDevExport';

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

/** The tags the gesture and animation stack prefixes every message with. */
const STACK_MESSAGE = /^\s*\[(react-native-gesture-handler|Reanimated|Worklets)\]/;
const LOAD_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 30_000;

const dist = arg('dist');
const url = arg('url');
if (!dist === !url) throw new Error('one of --dist=<an `expo export --dev` output> or --url=');
const served = dist ? serveDevExport(dist) : null;
const origin = served?.origin ?? new URL(url).origin;

const stackMessages: string[] = [];
const uncaught: string[] = [];
const otherErrors = new Set<string>();

const outDir = arg('out');
if (outDir) mkdirSync(outDir, { recursive: true });
/** Steps that could not do what they say (a surface that never opened). */
const broken: string[] = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function step(page: Page, name: string, run: () => Promise<void>) {
  const before = stackMessages.length + uncaught.length;
  try {
    await run();
    // Let what the step started (attach, re-render, a spring) run out.
    await page.waitForTimeout(750);
  } catch (error) {
    broken.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  }
  if (outDir) await page.screenshot({ path: join(outDir, `${name.replace(/\W+/g, '-')}.png`) });
  const spoke = stackMessages.length + uncaught.length > before;
  console.log(`${spoke || broken.at(-1)?.startsWith(`${name}:`) ? 'FAIL' : 'ok  '} ${name}`);
}

/** Drag with the mouse from (x, fromY) to (x, toY), in small steps. */
async function drag(page: Page, x: number, fromY: number, toY: number) {
  await page.mouse.move(x, fromY);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, fromY + ((toY - fromY) * i) / steps);
  await page.mouse.up();
}

async function box(page: Page, testId: string) {
  const found = await page.getByTestId(testId).first().boundingBox();
  if (!found) throw new Error(`${testId} is not on the page`);
  return found;
}

const placeRow = (page: Page) => page.locator('[data-testid^="place-row-"]').first();

/** Out of a place, if one is open, back to the list. */
async function backToList(page: Page) {
  const back = page.getByRole('button', { name: 'Back to nearby places' });
  if (await back.isVisible()) await back.click();
  await placeRow(page).waitFor();
}

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  page.on('console', (message) => {
    const text = message.text();
    if (STACK_MESSAGE.test(text)) stackMessages.push(`[${message.type()}] ${text}`);
    else if (message.type() === 'error' && !text.startsWith('Failed to load resource')) {
      otherErrors.add(text.split('\n')[0]?.slice(0, 200) ?? text);
    }
  });
  page.on('pageerror', (error) => uncaught.push(error.stack ?? error.message));

  await step(page, 'load', async () => {
    await page.goto(`${origin}/`, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await placeRow(page).waitFor({ timeout: LOAD_TIMEOUT_MS });
  });

  // The overlays first: the sheet, once raised, covers the map's top bar.
  await step(page, 'map settings', async () => {
    await page.getByTestId('map-settings').click();
    await page.getByTestId('map-settings-modal').waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId('map-settings-modal').waitFor({ state: 'hidden' });
  });

  await step(page, 'map style', async () => {
    await page.getByTestId('map-style-button').click();
    await page.getByTestId('map-style-picker').waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId('map-style-picker').waitFor({ state: 'hidden' });
  });

  await step(page, 'drag the sheet up by its body', async () => {
    const start = (await box(page, 'explore-sheet-handle')).y;
    const row = await placeRow(page).boundingBox();
    if (!row) throw new Error('no place row to drag from');
    await drag(page, row.x + row.width / 2, row.y + row.height / 2, 120);
    await page.waitForTimeout(1_000);
    const raised = (await box(page, 'explore-sheet-handle')).y;
    if (!(raised < start - 100)) throw new Error(`the sheet did not rise (${start} → ${raised})`);
    // The mouse rode the row up with the sheet, so the press may have opened it.
    await backToList(page);
  });

  await step(page, 'drag the sheet down by its handle', async () => {
    const handle = await box(page, 'explore-sheet-handle');
    await drag(page, handle.x + handle.width / 2, handle.y + handle.height / 2, 640);
    await page.waitForTimeout(1_000);
    const lowered = (await box(page, 'explore-sheet-handle')).y;
    if (!(lowered > handle.y + 100))
      throw new Error(`the sheet did not drop (${handle.y} → ${lowered})`);
  });

  await step(page, 'tap the sheet handle', async () => {
    await page.getByTestId('explore-sheet-handle').click();
  });

  await step(page, 'open a place and come back', async () => {
    await placeRow(page).click();
    await page.getByRole('button', { name: /^Directions to / }).waitFor();
    await backToList(page);
  });
} finally {
  await browser.close();
  served?.stop();
}

if (otherErrors.size > 0) {
  console.log(`\nOther console errors (not this gate's; ${otherErrors.size}):`);
  for (const text of otherErrors) console.log(`  ${text}`);
}
if (stackMessages.length > 0 || uncaught.length > 0 || broken.length > 0) {
  console.error('\nFAILED:');
  for (const text of broken) console.error(`  [step] ${text}`);
  for (const text of new Set(stackMessages)) console.error(`  ${text}`);
  for (const text of new Set(uncaught)) console.error(`  [uncaught] ${text}`);
  process.exit(1);
}
console.log('\nNothing from the gesture and animation stack, nothing uncaught.');
