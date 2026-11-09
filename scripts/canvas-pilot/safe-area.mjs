import { openPilot } from './browser.mjs';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { browser, page, output, errors, blocked } = await openPilot();
const frames = [];
const read = () =>
  page.getByTestId('map-top-bar').evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      padding: {
        top: parseFloat(s.paddingTop),
        left: parseFloat(s.paddingLeft),
        right: parseFloat(s.paddingRight),
      },
      rect: el.getBoundingClientRect().toJSON(),
      canvas: document
        .querySelector('[data-testid="explore-canvas"]')
        .getBoundingClientRect()
        .toJSON(),
    };
  });
try {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000);
  frames.push(await read());
  assert.deepEqual(frames[0].padding, { top: 24, left: 32, right: 20 });
  await page.screenshot({ path: `${output}/window-insets.png` });
  await page.getByTestId('explore-canvas').evaluate((el) =>
    Object.assign(el.style, {
      flex: 'none',
      width: '300px',
      height: '500px',
      marginLeft: '70px',
      marginTop: '40px',
    }),
  );
  await page.waitForTimeout(1000);
  frames.push(await read());
  assert.equal(frames[1].canvas.x, 70);
  assert.equal(frames[1].canvas.y, 40);
  assert.deepEqual(frames[1].padding, { top: 16, left: 16, right: 16 });
  await page.screenshot({ path: `${output}/local-host.png` });
  writeFileSync(
    `${output}/safe-area.json`,
    JSON.stringify(
      { frames, errors, blocked, locationCalls: await page.evaluate(() => window.__locationCalls) },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
