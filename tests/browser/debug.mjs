// Quick diagnostic: load one session and stream console output / crash info.
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
  protocolTimeout: 600000,
  dumpio: !!process.env.DUMPIO,
});
const page = await browser.newPage();
await page.setViewport({ width: 915, height: 412, isMobile: true, hasTouch: true });
page.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('error', (e) => console.log('CRASH', e.message));
await page.goto(process.argv[2] || 'http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__drift);
console.log('loaded app');
const t = Date.now();
page.evaluate((map, car) => {
  const { settings, ui } = window.__drift;
  settings.set('map', map);
  settings.set('car', car);
  ui.start();
}, process.env.MAP || 'forest', process.env.CAR || 'skyline').catch((e) => console.log('eval err', e.message));
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await page.evaluate(() => ({ state: window.__drift.ui.state, text: window.__drift.ui.loadingText.textContent, fps: window.__drift.game.fps })).catch((e) => ({ err: e.message }));
  console.log(((Date.now() - t) / 1000).toFixed(0) + 's', JSON.stringify(s));
  if (s.err || s.state === 'driving' || /Failed/.test(s.text || '')) break;
}
await page.screenshot({ path: 'test-output/debug.png' }).catch(() => {});
await browser.close();
