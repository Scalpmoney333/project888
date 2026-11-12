// Load a session and print the result of a JS expression evaluated in the page.
// Usage: MAP=nagao CAR=chaser node tests/browser/eval.mjs "<expression using game>"
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 420 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__drift);
await page.evaluate(async (map, car) => {
  const { settings, ui } = window.__drift;
  settings.set('map', map);
  settings.set('car', car);
  await ui.start();
}, process.env.MAP || 'forest', process.env.CAR || 'chaser');
await page.waitForFunction(() => window.__drift.ui.state === 'driving');
const out = await page.evaluate(`(() => { const { game, settings } = window.__drift; return ${process.argv[2]}; })()`);
console.log(JSON.stringify(out));
if (process.env.SHOT) await page.screenshot({ path: `test-output/${process.env.SHOT}.png` });
await browser.close();
