import { openPilot } from './browser.mjs';
import { writeFileSync } from 'node:fs';
const { browser, page, output, errors, blocked } = await openPilot();
try {
  const zoom = page.getByTestId('map-controls-zoom-in');
  await zoom.focus();
  await page.evaluate(() => {
    window.savedZoom = document.activeElement;
  });
  const beforeResize = await page.evaluate(() => window.__gowayReliefMap.getZoom());
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(1500);
  writeFileSync(
    `${output}/resize-debug.json`,
    JSON.stringify(
      await page.evaluate(() => ({
        active: {
          tag: document.activeElement?.tagName,
          id: document.activeElement?.getAttribute('data-testid'),
        },
        zoom: document
          .querySelector('[data-testid="map-controls-zoom-in"]')
          ?.getBoundingClientRect()
          .toJSON(),
        ancestors: (() => {
          let e = document.querySelector('[data-testid="map-controls-zoom-in"]');
          const a = [];
          while (e) {
            a.push({
              tag: e.tagName,
              id: e.getAttribute('data-testid'),
              display: getComputedStyle(e).display,
              opacity: getComputedStyle(e).opacity,
              rect: e.getBoundingClientRect().toJSON(),
            });
            e = e.parentElement;
          }
          return a;
        })(),
      })),
      null,
      2,
    ),
  );
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'explore-panel-handle',
    {},
    { timeout: 10000 },
  );
  const afterResize = await page.evaluate(() => window.__gowayReliefMap.getZoom());
  if (beforeResize !== afterResize) throw new Error('Resize moved camera');
  const handle = page.getByTestId('explore-panel-handle');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(800);
  if ((await handle.getAttribute('aria-valuenow')) !== '0')
    throw new Error('Handle failed recovery to peek');
  const traversal = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    const id = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    traversal.push(id);
    if (id === 'map-controls-zoom-in') break;
  }
  if (traversal.at(-1) !== 'map-controls-zoom-in')
    throw new Error('Zoom was not keyboard-recoverable');
  if (!(await page.evaluate(() => window.savedZoom === document.activeElement)))
    throw new Error('Zoom identity changed');
  await page.keyboard.press('Enter');
  await page.waitForFunction((z) => window.__gowayReliefMap.getZoom() > z + 0.5, beforeResize);
  await page.screenshot({ path: `${output}/recovered.png` });
  const identity = await page.evaluate(() => ({
    map: window.__baselineMap === window.__gowayReliefMap,
    canvas: window.__baselineCanvas === document.querySelector('canvas'),
    input: window.__baselineSearch === document.querySelector('input'),
  }));
  if (Object.values(identity).some((v) => !v)) throw new Error('Resize remounted scene');
  writeFileSync(
    `${output}/focus.json`,
    JSON.stringify(
      {
        beforeResize,
        afterResize,
        afterZoom: await page.evaluate(() => window.__gowayReliefMap.getZoom()),
        traversal,
        identity,
        errors,
        blocked,
        locationCalls: await page.evaluate(() => window.__locationCalls),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
