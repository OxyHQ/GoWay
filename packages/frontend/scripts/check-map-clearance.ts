/**
 * Drive the real exported GoWay map at narrow widths. A synthetic style keeps
 * the test offline while MapLibre, React Native Web and the map chrome render.
 */
import { chromium, type Page } from 'playwright-core';
import { serveDevExport } from './serveDevExport';

const dist = process.argv.find((arg) => arg.startsWith('--dist='))?.slice('--dist='.length);
if (!dist) throw new Error('Pass --dist=<web export>');
const served = serveDevExport(dist);
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-networking',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ],
});

async function setExpanded(page: Page, expanded: boolean) {
  const toggle = page.getByTestId('map-credit-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) {
    // GoWay's sheet may cover the map. Exercise the real toggle without
    // requiring the sheet's unrelated gesture state to expose it.
    await toggle.evaluate((element) => (element as HTMLElement).click());
  }
  await page.waitForFunction(
    (value) =>
      document.querySelector('[data-testid="map-credit-toggle"]')?.getAttribute('aria-expanded') ===
      String(value),
    expanded,
  );
}

async function checkClearance(page: Page, width: number, expanded: boolean) {
  const map = page.getByTestId('goway-map');
  await map.evaluate((element, value) => {
    (element as HTMLElement).style.width = `${value}px`;
  }, width);
  await setExpanded(page, expanded);
  // Layout events cross the RN bridge asynchronously. Wait for the measured
  // credit to update the scale, but fail if either component disappears.
  try {
    await page.waitForFunction(
      (expected) => {
        const toggle = document.querySelector('[data-testid="map-credit-toggle"]');
        const credit = document
          .querySelector('[data-testid="map-credit"]')
          ?.getBoundingClientRect();
        const scale = document.querySelector('[data-testid="map-scale"]')?.getBoundingClientRect();
        if (toggle?.getAttribute('aria-expanded') !== String(expected)) return false;
        if (
          !credit ||
          !scale ||
          credit.width <= 0 ||
          credit.height <= 0 ||
          scale.width <= 0 ||
          scale.height <= 0
        )
          return false;
        return (
          scale.bottom <= credit.top ||
          credit.bottom <= scale.top ||
          scale.right <= credit.left ||
          credit.right <= scale.left
        );
      },
      expanded,
      { timeout: 2_000 },
    );
  } catch (error) {
    const geometry = await page.evaluate(() => {
      const box = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().toJSON();
      return { scale: box('map-scale'), credit: box('map-credit') };
    });
    throw new Error(
      `No clearance at ${width}px (expanded=${expanded}): ${JSON.stringify(geometry)}`,
      { cause: error },
    );
  }
  const bounds = await map.boundingBox();
  if (!bounds || Math.abs(bounds.width - width) > 1)
    throw new Error(`Map did not resize to ${width}`);
  if (
    expanded &&
    (await page
      .locator('[data-testid="map-credit"] [role="link"][aria-label="© OpenStreetMap"]')
      .count()) !== 1
  ) {
    throw new Error('Expanded credit lost its OpenStreetMap link');
  }
  console.log(`ok map ${width}px, credit ${expanded ? 'expanded' : 'folded'}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === served.origin) return route.continue();
    if (url.hostname === 'goway.to' && url.pathname.includes('/styles/')) {
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          sources: {},
          layers: [{ id: 'background', type: 'background' }],
        }),
      });
    }
    return route.abort();
  });
  await page.goto(served.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByTestId('map-scale').waitFor({ timeout: 60_000 });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    for (const width of [200, 240, 320]) {
      await checkClearance(page, width, true);
      const expandedBox = await page.getByTestId('map-scale').boundingBox();
      await checkClearance(page, width, false);
      if (width === 200 && expandedBox) {
        await page.waitForFunction(
          (top) => {
            const box = document
              .querySelector('[data-testid="map-scale"]')
              ?.getBoundingClientRect();
            return !!box && box.top > top + 1;
          },
          expandedBox.y,
          { timeout: 2_000 },
        );
        const foldedBox = await page.getByTestId('map-scale').boundingBox();
        if (!foldedBox) throw new Error('The folded scale disappeared');
        await checkClearance(page, width, true);
        await page.waitForFunction(
          (top) => {
            const box = document
              .querySelector('[data-testid="map-scale"]')
              ?.getBoundingClientRect();
            return !!box && box.top < top - 1;
          },
          foldedBox.y,
          { timeout: 2_000 },
        );
      }
    }
  }
} finally {
  await browser.close();
  served.stop();
}
