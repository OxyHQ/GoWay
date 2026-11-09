import { openPilot } from './browser.mjs';
import { writeFileSync } from 'node:fs';
const { browser, page, output, errors, blocked } = await openPilot();
try {
  await page.setViewportSize({
    width: Number(process.env.ROOM_WIDTH ?? 390),
    height: Number(process.env.ROOM_HEIGHT ?? 844),
  });
  await page.waitForTimeout(1500);
  const frames = [];
  for (const snap of ['half', 'full', 'peek']) {
    const handle = page.getByTestId('explore-panel-handle');
    await handle.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    for (let i = 0; i < { peek: 0, half: 1, full: 2 }[snap]; i++)
      await page.keyboard.press('ArrowUp');
    const value = await handle.getAttribute('aria-valuenow');
    if (Number(value) !== { peek: 0, half: 1, full: 2 }[snap])
      throw new Error(`Wrong detent ${snap}: ${value}`);
    await page.waitForTimeout(800);
    const toggle = page.getByTestId('map-credit-toggle');
    const before = await toggle.getAttribute('aria-expanded');
    await toggle.click();
    await page.waitForTimeout(350);
    const after = await toggle.getAttribute('aria-expanded');
    const targets = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('button,a,[role="button"],[role="slider"],[role="link"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          name: el.getAttribute('aria-label'),
          role: el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : el.tagName.toLowerCase()),
          href: el.getAttribute('href'),
          rect: r.toJSON(),
          hit: hit === el || el.contains(hit),
        };
      }),
    );
    await page.screenshot({ path: `${output}/${snap}.png` });
    const keyboard = [];
    for (const link of await page.getByRole('link').all()) {
      const href = await link.getAttribute('href');
      if (!href?.startsWith('https://')) continue;
      await link.focus();
      const focused = await link.evaluate((el) => document.activeElement === el);
      keyboard.push({ href, focused });
    }
    const topTargets = [];
    for (const name of [
      'Sign in',
      'Organization lists',
      'Map style',
      'Map settings',
      'My location',
      'Zoom in',
      'Zoom out',
      'Tilt the map',
    ]) {
      const target = page.getByRole('button', { name, exact: true });
      if ((await target.count()) !== 1) continue;
      if (!(await target.isVisible())) {
        topTargets.push({ name, hidden: true });
        continue;
      }
      const result = await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { rect: r.toJSON(), hit: el === hit || el.contains(hit) };
      });
      topTargets.push({ name, ...result });
      if (process.env.COARSE === '1' && (result.rect.height < 44 || result.rect.width < 44))
        throw new Error(`Small target ${name}`);
      if (!result.hit) throw new Error(`Covered target ${name} at ${snap}`);
    }
    const links = page.getByRole('link');
    const traversal = [];
    if (await links.count()) {
      await links.first().focus();
      for (let i = 0; i < (await links.count()); i++) {
        traversal.push(await page.evaluate(() => document.activeElement?.getAttribute('href')));
        await page.keyboard.press('Tab');
      }
    }
    frames.push({ snap, value, before, after, targets, keyboard, topTargets, traversal });
    if (after === 'true') await toggle.click();
  }
  writeFileSync(
    `${output}/targets.json`,
    JSON.stringify(
      { frames, errors, blocked, locationCalls: await page.evaluate(() => window.__locationCalls) },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
