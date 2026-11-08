import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
export async function openPilot() {
  const output =
    process.env.BASELINE_OUTPUT ?? 'packages/frontend/.local/issue-663/browser-runs/default';
  mkdirSync(output, { recursive: true });
  const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON);
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    hasTouch: process.env.COARSE === '1',
    colorScheme: process.env.MODE ?? 'light',
  });
  const errors = [],
    requests = [],
    blocked = [];
  await context.addInitScript(() => {
    window.__locationCalls = 0;
    for (const key of ['getCurrentPosition', 'watchPosition']) {
      const original = navigator.geolocation[key].bind(navigator.geolocation);
      navigator.geolocation[key] = (...args) => {
        window.__locationCalls++;
        return original(...args);
      };
    }
  });
  await context.route('**/*', async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    requests.push(`${req.method()} ${u.origin}${u.pathname}`);
    if (u.hostname === 'api.oxy.so' && u.pathname.startsWith('/auth/oauth/client/'))
      return route.fulfill({
        json: {
          application: {
            id: 'fixture-app',
            name: 'GoWay baseline',
            type: 'internal',
            isOfficial: true,
            isInternal: true,
            clientId: 'fixture-goway',
            scopes: [],
          },
        },
        headers: { 'access-control-allow-origin': '*' },
      });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && u.hostname !== 'localhost') {
      blocked.push(`${req.method()} ${u.origin}${u.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  if (process.env.SAFE_AREA) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: JSON.parse(process.env.SAFE_AREA),
    });
  }
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(process.env.CANVAS_URL ?? 'http://localhost:8132', {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__gowayReliefMap, { timeout: 120000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      window.__baselineMap = window.__gowayReliefMap;
      window.__baselineCanvas = document.querySelector('canvas');
      window.__baselineSearch = document.querySelector('input');
    });
    return { browser, context, page, output, errors, blocked };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
