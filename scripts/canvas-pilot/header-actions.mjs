import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPilot } from './browser.mjs';

const run = await openPilot();

try {
  const samples = [];

  for (const width of [320, 390, 768, 1440, 320]) {
    await run.page.setViewportSize({ width, height: 844 });
    await run.page.waitForTimeout(1500);
    const sample = await run.page.evaluate(() => {
      const header = document.querySelector('[data-testid="map-top-bar"]');
      const actions = document.querySelector('[data-testid="map-top-bar-actions"]');
      if (!header || !actions) throw new Error('GoWay map header or action row is missing');
      const headerBounds = header.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      const buttons = [...actions.querySelectorAll('button,[role="button"]')]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0' &&
            !element.closest('[aria-hidden="true"]')
          );
        })
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label') || element.textContent?.trim(),
            x: Number(bounds.x.toFixed(1)),
            y: Number(bounds.y.toFixed(1)),
            right: Number(bounds.right.toFixed(1)),
            width: Number(bounds.width.toFixed(1)),
            height: Number(bounds.height.toFixed(1)),
          };
        });

      return {
        width: innerWidth,
        header: {
          x: Number(headerBounds.x.toFixed(1)),
          width: Number(headerBounds.width.toFixed(1)),
          height: Number(headerBounds.height.toFixed(1)),
        },
        actions: {
          x: Number(actionBounds.x.toFixed(1)),
          width: Number(actionBounds.width.toFixed(1)),
          clientWidth: actions.clientWidth,
        },
        buttons,
      };
    });

    const rows = [...new Set(sample.buttons.map((button) => Math.round(button.y)))];
    assert.equal(rows.length, 1, `${width}px header actions wrapped into ${rows.length} rows`);
    assert(
      sample.buttons.every(
        (button) => button.right <= sample.actions.x + sample.actions.clientWidth + 1,
      ),
      `${width}px header action escaped its measured row`,
    );
    samples.push(sample);
  }

  const narrow = samples.at(-1);
  const wide = samples.find((sample) => sample.width === 1440);
  for (const label of ['Ask Alia', 'Organization lists', 'More']) {
    assert(
      narrow.buttons.some((button) => button.label === label),
      `missing narrow action: ${label}`,
    );
  }
  for (const label of ['Ask Alia', 'Organization lists', 'Saved', 'Contribute']) {
    assert(
      wide.buttons.some((button) => button.label === label),
      `missing wide action: ${label}`,
    );
  }

  const output = join(run.output, 'header-actions-320.png');
  await run.page.screenshot({ path: output, fullPage: false });
  await run.page.getByTestId('map-top-bar-actions-overflow').click();
  const menuLabels = await run.page.getByRole('menuitem').allTextContents();
  assert(menuLabels.includes('Saved'), 'Saved action missing from the narrow overflow menu');
  assert(
    menuLabels.includes('Contribute'),
    'Contribute action missing from the narrow overflow menu',
  );
  assert.deepEqual(run.errors, [], `browser errors: ${run.errors.join('; ')}`);

  const report = {
    verifiedAt: new Date().toISOString(),
    browserVersion: run.browser.version(),
    widths: samples,
    narrowOverflow: menuLabels,
    pageErrors: run.errors,
    screenshot: 'header-actions-320.png',
  };
  writeFileSync(join(run.output, 'header-actions.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await run.browser.close();
}
