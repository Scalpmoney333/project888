// UI flow test (mobile emulation): menu, settings tabs, manual gearbox via touch buttons,
// HUD editor drag + resize, and persistence of settings across a page reload.
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 915, height: 412, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await page.createCDPSession();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = async (x, y, id = 1) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
  await sleep(120);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
};
const centerOf = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const report = {};

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__drift);
await sleep(500);
await page.screenshot({ path: 'test-output/ui-menu.png' });

// Settings: switch to manual via the real <select>, take tab screenshots.
await page.evaluate(() => window.__drift.ui.showSettings('menu'));
await page.evaluate(() => {
  const sel = [...document.querySelectorAll('.settings select')].find((s) => [...s.options].some((o) => o.value === 'manual'));
  sel.value = 'manual';
  sel.dispatchEvent(new Event('change'));
});
await sleep(200);
await page.screenshot({ path: 'test-output/ui-settings-driving.png' });
for (const tab of ['Assists', 'Camera', 'Graphics', 'Tuning']) {
  await page.evaluate((t) => [...document.querySelectorAll('.tabs button')].find((b) => b.textContent === t).click(), tab);
  await sleep(200);
  await page.screenshot({ path: `test-output/ui-settings-${tab.toLowerCase()}.png` });
}
report.transmission = await page.evaluate(() => window.__drift.settings.data.driving.transmission);
// New options: pedal mode select and vibration toggle are real controls bound to settings.
report.options = await page.evaluate(() => {
  const ui = window.__drift.ui;
  ui.tab = 'driving'; ui.showSettings();
  const pedals = [...document.querySelectorAll('.settings select')].find((s) => [...s.options].some((o) => o.value === 'regular'));
  pedals.value = 'regular'; pedals.dispatchEvent(new Event('change'));
  ui.tab = 'hud'; ui.showSettings();
  const vib = [...document.querySelectorAll('.settings label')].find((l) => l.textContent.startsWith('Vibration')).querySelector('input');
  vib.click();
  const s = window.__drift.settings.data;
  return { pedals: s.driving.pedals, vibration: s.hud.vibration, wheelRange: s.driving.wheelRange };
});

// Start driving on the forest map (MT).
await page.evaluate(async () => {
  const { settings, ui } = window.__drift;
  settings.set('map', 'oi');
  settings.set('car', 'skyline');
  ui.closeSettings();
  await ui.start();
});
await page.waitForFunction(() => window.__drift.ui.state === 'driving');
await sleep(800);
const gearUp = await centerOf('.ctl-gearUp');
const gearDown = await centerOf('.ctl-gearDown');
const g0 = await page.evaluate(() => window.__drift.game.vehicle.gear);
await tap(gearDown.x, gearDown.y);
await sleep(600);
const g1 = await page.evaluate(() => window.__drift.game.vehicle.gear);
await tap(gearUp.x, gearUp.y);
await sleep(600);
await tap(gearUp.x, gearUp.y);
await sleep(600);
const g2 = await page.evaluate(() => window.__drift.game.vehicle.gear);
report.manualGears = { start: g0, afterDown: g1, afterTwoUps: g2 };
await page.screenshot({ path: 'test-output/ui-manual-hud.png' });

// Camera + reset buttons
const cam = await centerOf('.ctl-camera');
const m0 = await page.evaluate(() => window.__drift.game.cameraRig.mode);
await tap(cam.x, cam.y);
report.cameraButton = { before: m0, after: await page.evaluate(() => window.__drift.game.cameraRig.mode) };

// HUD editor: drag the throttle pedal and resize it.
await page.evaluate(() => { window.__drift.ui.back = 'pause'; window.__drift.ui.openEditor(); });
await sleep(200);
const thr = await centerOf('.ctl-throttle');
const before = await page.evaluate(() => ({ ...window.__drift.settings.data.hud.layout.throttle }));
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: thr.x, y: thr.y, id: 5 }] });
for (let i = 1; i <= 6; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: thr.x - i * 15, y: thr.y - i * 5, id: 5 }] });
  await sleep(30);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(200);
await page.$eval('.editor-bar input[type=range]', (el) => { el.value = 140; el.dispatchEvent(new Event('input')); });
await page.screenshot({ path: 'test-output/ui-hud-editor.png' });
await page.evaluate(() => [...document.querySelectorAll('.editor-bar button')].find((b) => b.textContent === 'Save').click());
const after = await page.evaluate(() => ({ ...window.__drift.settings.data.hud.layout.throttle }));
report.hudEditor = { before, after };

// Persistence across reload
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__drift);
report.persisted = await page.evaluate(() => ({ throttle: window.__drift.settings.data.hud.layout.throttle, transmission: window.__drift.settings.data.driving.transmission }));
report.errors = errors;
console.log(JSON.stringify(report));
await browser.close();
