// Browser smoke test under Android-like mobile emulation (headless Chrome, SwiftShader WebGL).
// Usage: node tests/browser/smoke.mjs [baseUrl]   (serve the build first: npm run build && npm run preview)
// Loads both maps, checks wheel pivots, drives with real CDP multitouch (wheel + throttle +
// handbrake at once), cycles all camera modes and saves screenshots to test-output/.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:4173/';
const only = process.env.MAPS ? process.env.MAPS.split(',') : ['nagao', 'tsukuba', 'shomaru', 'nagao_gta', 'tsukuba_gta'];
const cars = process.env.CARS ? process.env.CARS.split(',') : ['skyline', 'chaser', 'markii', 's15', 's13', 'markii_gta'];
// Every map once (cars rotated), then any car not yet covered on the first map.
const pairs = only.map((m, i) => [m, cars[i % cars.length]]);
for (const c of cars) if (!pairs.some((p) => p[1] === c)) pairs.push([only[0], c]);
fs.mkdirSync('test-output', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 915, height: 412, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
});
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
const cdp = await page.createCDPSession();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__drift, { timeout: 60000 });
const results = [];

async function center(sel) {
  return page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
}
async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 4, radiusY: 4, force: 1 })) });
}

for (const [pairIndex, [map, car]] of pairs.entries()) {
  {
    const t0 = Date.now();
    await page.evaluate(async (map, car) => {
      const { settings, ui } = window.__drift;
      settings.set('map', map);
      settings.set('car', car);
      settings.set('hud.showTelemetry', true);
      await ui.start();
    }, map, car);
    await page.waitForFunction(() => window.__drift.ui.state === 'driving', { timeout: 600000 });
    const loadSec = (Date.now() - t0) / 1000;
    await sleep(1500);

    // Wheel pivots: each spin group's geometry should be centred on its pivot.
    const pivots = await page.evaluate(() => {
      const { game } = window.__drift;
      const THREE = game.renderer.constructor; void THREE;
      return game.model.wheels.map((w) => {
        w.spin.updateWorldMatrix(true, true);
        const box = new (game.model.bodyBox.constructor)().setFromObject(w.spin);
        const c = box.getCenter(new (game.model.bodyBox.min.constructor)());
        const p = w.spin.getWorldPosition(new (game.model.bodyBox.min.constructor)());
        return { name: w.root.name, offsetCm: +(c.distanceTo(p) * 100).toFixed(1), parts: w.spin.children.length + w.steer.children.length - 1 };
      });
    });
    await page.screenshot({ path: `test-output/${map}-${car}-start.png` });

    // Multitouch: steering wheel + throttle together, then add the handbrake.
    let multitouch = null;
    if (pairIndex === 0) {
      const wheel = await center('.ctl-wheel');
      const thr = await center('.ctl-throttle');
      const hb = await center('.ctl-handbrake');
      const top = { x: wheel.x, y: wheel.y - wheel.h * 0.35, id: 1 };
      const gas = { x: thr.x, y: thr.y - thr.h * 0.3, id: 2 };
      await touch('touchStart', [top]);
      await touch('touchStart', [top, gas]);
      // drag finger clockwise around the wheel by ~70 degrees => steer right
      for (let a = 0; a <= 300; a += 15) {
        const r = wheel.h * 0.35, rad = (a - 90) * Math.PI / 180;
        await touch('touchMove', [{ x: wheel.x + Math.cos(rad) * r, y: wheel.y + Math.sin(rad) * r, id: 1 }, gas]);
        await sleep(30);
      }
      await sleep(2500);
      const rad = (300 - 90) * Math.PI / 180;
      const held = { x: wheel.x + Math.cos(rad) * wheel.h * 0.35, y: wheel.y + Math.sin(rad) * wheel.h * 0.35, id: 1 };
      await touch('touchStart', [held, gas, { x: hb.x, y: hb.y, id: 3 }]);
      await sleep(600);
      multitouch = await page.evaluate(() => {
        const { game } = window.__drift;
        const v = game.vehicle;
        return {
          input: { ...game.input.state },
          frontSteerDeg: v.wheels.slice(0, 2).map((w) => +(w.steer * 57.3).toFixed(1)),
          rearOmega: v.wheels.slice(2).map((w) => +w.omega.toFixed(1)),
          speedKmh: +(v.speed * 3.6).toFixed(1),
          gear: v.gear,
        };
      });
      await page.screenshot({ path: `test-output/${map}-${car}-multitouch.png` });
      await touch('touchEnd', []);
      await sleep(300);
    }

    // Drive a bit with keyboard-free scripted input and cycle every camera mode.
    const cams = [];
    for (let m = 0; m < 5; m++) {
      await page.evaluate((m) => window.__drift.game.cameraRig.setMode(m), m);
      await sleep(900);
      await page.screenshot({ path: `test-output/${map}-${car}-cam${m}.png` });
      cams.push(m);
    }
    const state = await page.evaluate(() => {
      const { game } = window.__drift;
      const v = game.vehicle;
      return {
        fps: Math.round(game.fps),
        y: +v.position.y.toFixed(2),
        upright: +(1 - 2 * (v.quaternion.x ** 2 + v.quaternion.z ** 2)).toFixed(3),
        contacts: v.wheels.map((w) => (w.contact ? w.surface.name : 'air')),
        spin: v.wheels.map((w) => +w.spinAngle.toFixed(2)),
      };
    });
    // Every start position: the car must land on a drivable surface and stay upright.
    const spawnChecks = [];
    const spawnIds = await page.evaluate(() => window.__drift.game.map.spawns.map((s) => s.id));
    for (const id of spawnIds) {
      await page.evaluate((id) => { const { game } = window.__drift; game.setSpawn(id); game.cameraRig.setMode(0); }, id);
      await sleep(1800);
      await page.screenshot({ path: `test-output/${map}-spawn-${id}.png` });
      spawnChecks.push(await page.evaluate((id) => {
        const v = window.__drift.game.vehicle;
        return { id, contacts: v.wheels.map((w) => (w.contact ? w.surface.name : 'air')).join(','), upright: +(1 - 2 * (v.quaternion.x ** 2 + v.quaternion.z ** 2)).toFixed(3), y: +v.position.y.toFixed(1) };
      }, id));
    }
    results.push({ map, car, loadSec, pivots, multitouch, state, spawnChecks });
    await page.evaluate(() => window.__drift.ui.showMenu());
    await sleep(300);
  }
}

console.log(JSON.stringify({ results, errors: [...new Set(errors)].slice(0, 30) }, null, 1));
await browser.close();
