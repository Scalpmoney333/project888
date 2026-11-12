// Feature check (mobile emulation): new GTA maps + Chaser, free look hold/return, drone flight,
// HUD hide/restore, top-left speedometer colour, and "Original" paint restore.
// Usage: node tests/browser/features.mjs [baseUrl]   (serve the build first)
import puppeteer from 'puppeteer-core';

const base = process.argv[2] || 'http://localhost:4173/';
const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], protocolTimeout: 900000,
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
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ ...p, radiusX: 4, radiusY: 4, force: 1 })) });
const centerOf = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const tap = async (sel) => { const c = await centerOf(sel); await touch('touchStart', [{ ...c, id: 1 }]); await sleep(120); await touch('touchEnd', []); await sleep(200); };
const results = {};
const check = (name, ok, info) => { results[name] = { ok: !!ok, info }; };

await page.goto(base, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__drift, { timeout: 60000 });

for (const [map, car] of [['tsukuba_gta', 'chaser_gta'], ['nagao_gta', 'chaser_gta']]) {
  await page.evaluate(async (map, car) => {
    const { settings, ui } = window.__drift;
    settings.set('map', map); settings.set('car', car);
    await ui.start();
  }, map, car);
  await page.waitForFunction(() => window.__drift.ui.state === 'driving', { timeout: 600000 });
  await sleep(2000);
  const st = await page.evaluate(() => { const v = window.__drift.game.vehicle; return { y: v.position.y, grounded: v.wheels.filter((w) => w.contact).length }; });
  check(`load ${map} + ${car}`, st.grounded >= 3, st);
  const tint = await page.evaluate(() => { const g = window.__drift.game; return [...new Set(g.model.body.children.filter((m) => new RegExp(g.carDef.model.paintMaterial, 'i').test(m.material.name || '')).map((m) => m.material.color.getHexString()))]; });
  check(`${car} default paint`, tint.join() === '7d1a38', tint);
  await page.screenshot({ path: `test-output/features-${map}.png` });
}

// Speedometer: top-left, colour from settings.
const gauge = await page.$eval('.gauge', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top }; });
check('speedometer top-left', gauge.left < 20 && gauge.top < 20, gauge);
await page.evaluate(() => window.__drift.settings.set('hud.speedoColor', '#3fb8ff'));
const bluePixels = () => {
  const ctx = document.querySelector('.gauge canvas').getContext('2d');
  const d = ctx.getImageData(0, 0, 260, 150).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - 0x3f) < 30 && Math.abs(d[i + 1] - 0xb8) < 30 && d[i + 2] > 220) n++;
  return n;
};
// Headless software GL renders the big maps at ~1 fps, so wait on outcomes rather than fixed sleeps.
await page.waitForFunction(`(${bluePixels})() > 30`, { timeout: 120000 }).catch(() => {});
const px = await page.evaluate(`(${bluePixels})()`);
check('speedometer colour applied', px > 30, { bluePixels: px });

// Free look: drag empty screen, hold ~1 s after release, then ease back.
const rig = () => page.evaluate(() => ({ yaw: window.__drift.game.cameraRig.lookYaw || 0 }));
await touch('touchStart', [{ x: 460, y: 200, id: 7 }]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: 460 + i * 25, y: 200, id: 7 }]); await sleep(30); }
await sleep(300);
const during = await rig();
await touch('touchEnd', []);
await sleep(500);
const held = await rig();
const t0 = Date.now();
await page.waitForFunction(() => Math.abs(window.__drift.game.cameraRig.lookYaw) < 0.02, { timeout: 120000 }).catch(() => {});
const after = { ...(await rig()), returnedAfterMs: Date.now() - t0 + 500 };
check('free look moves view', Math.abs(during.yaw) > 0.3, during);
check('free look held after release', Math.abs(held.yaw) >= Math.abs(during.yaw) * 0.99, held);
check('free look returns', Math.abs(after.yaw) < 0.02 && after.returnedAfterMs > 1000, after);

// Drone: enter via touch button, fly with the stick, hide/restore HUD, exit.
await tap('.ctl-drone');
const inDrone = await page.evaluate(() => ({ active: window.__drift.game.drone.active, mode: window.__drift.game.input.mode }));
check('drone enters', inDrone.active && inDrone.mode === 'drone', inDrone);
const p0 = await page.evaluate(() => window.__drift.game.camera.position.toArray());
const sc = await centerOf('.ctl-droneStick');
await touch('touchStart', [{ ...sc, id: 2 }]);
await touch('touchMove', [{ x: sc.x, y: sc.y - 60, id: 2 }]);
await page.waitForFunction((p0) => { const p = window.__drift.game.camera.position; return Math.hypot(p.x - p0[0], p.z - p0[2]) > 5; }, { timeout: 120000 }, p0).catch(() => {});
await touch('touchEnd', []);
const p1 = await page.evaluate(() => window.__drift.game.camera.position.toArray());
const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
check('drone flies with stick', moved > 5, { moved });
await page.screenshot({ path: 'test-output/features-drone.png' });
await tap('.ctl-hudToggle');
const hidden = await page.evaluate(() => ({
  gauge: getComputedStyle(document.querySelector('.gauge')).display,
  stick: document.querySelector('.ctl-droneStick').style.display,
  toggle: document.querySelector('.ctl-hudToggle').style.display,
}));
check('HUD hides, restore button stays', hidden.gauge === 'none' && hidden.stick === 'none' && hidden.toggle === '', hidden);
await page.screenshot({ path: 'test-output/features-hud-hidden.png' });
await tap('.ctl-hudToggle');
const shown = await page.evaluate(() => ({ gauge: getComputedStyle(document.querySelector('.gauge')).display, stick: document.querySelector('.ctl-droneStick').style.display }));
check('HUD restores', shown.gauge !== 'none' && shown.stick === '', shown);
await tap('.ctl-droneExit');
const out = await page.evaluate(() => ({ active: window.__drift.game.drone.active, wheel: document.querySelector('.ctl-wheel').style.display }));
check('drone exits to driving', !out.active && out.wheel === '', out);

// Paint: repaint, then "Original" restores the model's own material colour.
const paint = await page.evaluate(() => {
  const { game, settings } = window.__drift;
  const mats = () => game.model.body.children.filter((m) => new RegExp(game.carDef.model.paintMaterial, 'i').test(m.material.name || '')).map((m) => m.material.color.getHexString());
  settings.set('paint.chaser', '#c8102e');
  settings.set('car', 'chaser');
  return { mats };
});
await page.evaluate(async () => { await window.__drift.ui.start(); });
await page.waitForFunction(() => window.__drift.ui.state === 'driving', { timeout: 600000 });
const pr = await page.evaluate(() => {
  const { game, settings } = window.__drift;
  const mats = () => [...new Set(game.model.body.children.filter((m) => new RegExp(game.carDef.model.paintMaterial, 'i').test(m.material.name || '')).map((m) => m.material.color.getHexString()))];
  const red = mats();
  settings.set('paint.chaser', null);
  const orig = mats();
  const origStored = [...new Set(game.model.body.children.filter((m) => m.material.userData.origColor).map((m) => m.material.userData.origColor.getHexString()))];
  return { red, orig, origStored };
});
check('repaint then Original restores', pr.red.includes('c8102e') && pr.orig.join() === pr.origStored.join(), pr);
void paint;

check('no page errors', errors.length === 0, errors.slice(0, 5));
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
