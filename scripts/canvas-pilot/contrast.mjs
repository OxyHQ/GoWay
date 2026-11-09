import { openPilot } from './browser.mjs';
import { writeFileSync } from 'node:fs';
const { browser, page, output, errors, blocked } = await openPilot();
try {
  await page.setViewportSize({ width: 390, height: 844 });
  const handle = page.getByTestId('explore-panel-handle');
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(800);
  const scenes = [];
  for (const [name, center] of [
    ['land', [2.12, 41.5]],
    ['sea', [2.45, 41.25]],
  ]) {
    await page.evaluate((center) => window.__gowayReliefMap.jumpTo({ center, zoom: 11 }), center);
    await page.waitForTimeout(1800);
    const targets = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="explore-panel"]');
      const pr = panel.getBoundingClientRect();
      const targets = [...panel.querySelectorAll('*')]
        .filter((el) => el.childElementCount === 0 && el.textContent?.trim())
        .map((el) => ({ el, text: el.textContent.trim(), r: el.getBoundingClientRect() }))
        .filter(
          ({ r }) =>
            r.width > 2 &&
            r.height > 2 &&
            r.y >= pr.y &&
            r.bottom <= innerHeight &&
            r.x >= 0 &&
            r.right <= innerWidth,
        )
        .slice(0, 20);
      window.contrastTargets = targets.map(({ el }) => ({ el, color: el.style.color }));
      const measured = targets.map(({ el, text, r }) => ({
        text,
        color: getComputedStyle(el).color,
        rect: r.toJSON(),
      }));
      const input = panel.querySelector('input');
      window.contrastInput = { el: input, placeholder: input.getAttribute('placeholder') };
      measured.push({
        text: '[search placeholder]',
        color: getComputedStyle(input, '::placeholder').color,
        opacity: getComputedStyle(input, '::placeholder').opacity,
        rect: input.getBoundingClientRect().toJSON(),
      });
      return measured;
    });
    await page.screenshot({ path: `${output}/${name}.png` });
    await page.evaluate(() => {
      window.contrastTargets.forEach(({ el }) => {
        el.style.setProperty('color', 'transparent', 'important');
      });
      window.contrastInput.el.setAttribute('placeholder', '');
    });
    await page.screenshot({ path: `${output}/${name}-backing.png` });
    const stable = await page.evaluate(() =>
      window.contrastTargets.every(({ el }) => el.isConnected),
    );
    if (!stable) throw new Error('Text scene changed during backing capture');
    await page.evaluate(() => {
      window.contrastTargets.forEach(({ el, color }) => {
        el.style.color = color;
      });
      window.contrastInput.el.setAttribute('placeholder', window.contrastInput.placeholder);
    });
    scenes.push({
      name,
      center,
      targets,
      mode: await page.evaluate(() => ({
        scheme: getComputedStyle(document.body).colorScheme,
        dark: document.documentElement.classList.contains('dark'),
      })),
    });
  }
  writeFileSync(
    `${output}/contrast-targets.json`,
    JSON.stringify(
      { scenes, errors, blocked, locationCalls: await page.evaluate(() => window.__locationCalls) },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
