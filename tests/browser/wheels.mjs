// Inspect wheel rigs: part listing per corner + side/front close-ups with steering applied.
import puppeteer from 'puppeteer-core';

const car = process.env.CAR || 'chaser';
const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'], protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 420 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__drift);
await page.evaluate(async (car) => {
  const { settings, ui } = window.__drift;
  settings.set('map', 'ashinoko');
  settings.set('car', car);
  settings.set('hud.showTelemetry', false);
  await ui.start();
}, car);
await page.waitForFunction(() => window.__drift.ui.state === 'driving');
const parts = await page.evaluate(() => {
  const { game } = window.__drift;
  return game.model.wheels.map((w) => ({
    name: w.root.name,
    spin: w.spin.children.map((m) => `${m.material.name}:${m.geometry.attributes.position.count}`),
    steer: w.steer.children.filter((c) => c !== w.spin).map((m) => `${m.material.name}:${m.geometry.attributes.position.count}`),
    info: { r: +w.info.radius.toFixed(3), w: +w.info.width.toFixed(3), c: w.info.center.toArray().map((x) => +x.toFixed(2)) },
  }));
});
console.log(JSON.stringify({ parts, measured: await page.evaluate(() => window.__drift.game.model.measured) }, null, 1));

// Freeze sim and orbit a free camera around the car.
async function shot(name, camPos, steer, spin) {
  await page.evaluate((camPos, steer, spin) => {
    const { game } = window.__drift;
    game.setPaused(true);
    const v = game.vehicle;
    v.wheels[0].steer = v.wheels[1].steer = steer;
    for (const w of v.wheels) w.spinAngle = spin;
    game.cameraRig.update = () => {};
    const p = v.renderPosition;
    const q = v.renderQuaternion;
    const off = new (p.constructor)(...camPos).applyQuaternion(q).add(p);
    game.camera.position.copy(off);
    game.camera.lookAt(p.x, p.y - 0.1, p.z);
  }, camPos, steer, spin);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `test-output/wheels-${car}-${name}.png` });
}
await shot('left-side', [3.6, 0.3, 0.6], 0.45, 0.6);
await shot('right-side', [-3.6, 0.3, 0.6], -0.45, 1.2);
await shot('front', [0, 1.5, 4.5], 0.45, 0);
await browser.close();
