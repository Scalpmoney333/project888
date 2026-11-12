# Touge Drift — HTML5 / mobile RWD drift simulator

A three.js drift game for Android Chrome and desktop browsers, built on the uploaded car
models and maps. All cars are rear-wheel drive.

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable from a phone on the same network)
npm run build      # static build in dist/ (deploy anywhere; uses relative paths)
npm test           # headless physics acceptance tests (Node)
```

Browser checks (need `npm run build && npm run preview` running, plus Chrome):
`npm run test:browser` (both maps, both cars, wheel pivots, CDP multitouch, all cameras) and
`npm run test:ui` (menus, settings, manual gearbox buttons, HUD editor, persistence).
Screenshots go to `test-output/`.

## Controls

| Touch (landscape) | Keyboard | Gamepad |
| --- | --- | --- |
| Steering wheel (left) or ◀ ▶ arrows | A/D or ←/→ | Left stick |
| GAS / BRAKE pedals — press higher on the pedal for more | W/S or ↑/↓ | RT / LT |
| E-BRAKE | Space | A / B |
| ▲ ▼ gears, CLUTCH (manual only) | E / Q, X clutch | RB / LB, X |
| CAM, ⟲ reset to start, Ⅱ pause | C, R, Esc | Y, Back, Start |

All touch controls track their own pointer, so steering, throttle and handbrake work at the
same time. Every control can be moved and resized (Settings → HUD → Edit), and all settings are
stored in `localStorage`.

## Project layout

```
src/physics/    Vehicle.js (rigid body, suspension, wheel spin solve, assists, collisions)
                Tire.js (combined-slip Pacejka on a friction ellipse), Drivetrain.js (engine,
                clutch, AT/MT gearbox), CollisionWorld.js (three-mesh-bvh), surfaces.js
src/vehicle/    specs.js (per-car handling + tuning ranges), CarModel.js (GLB -> wheel rig)
src/world/      NagaoMap.js, ForestTrack.js, textures.js
src/camera/     CameraRig.js (chase, close chase, cinematic drift, hood, cockpit)
src/input/      Input.js (touch HUD, keyboard, gamepad)
src/fx/         Effects.js (pooled smoke/dust, skid marks, exhaust flames)
src/audio/      AudioEngine.js (procedural WebAudio engine, tires, impacts)
src/core/       Game.js (loop, session loading, recovery, adaptive resolution), settings.js
src/ui/         UI.js (menus, settings, gauges, HUD editor)
tools/          asset inspection / conversion scripts
tests/          physics tests (node:test) and browser scripts (puppeteer-core)
```

Handling is data-driven: change `src/vehicle/specs.js` (or the in-game Tuning tab) without
touching the simulation. Physics runs at a fixed 240 Hz with render interpolation, so it
behaves the same at 30, 60 or 144 FPS.

## Assets

* **Cars** — `public/assets/cars/*.glb` are the uploaded Sketchfab files, unmodified. At load
  time `CarModel` bakes the node transforms, finds the four wheels (splitting merged meshes into
  connected components for the Chaser, whose rims are one mesh per axle and whose tyres share a
  mesh with body parts), builds `wheelRoot → steer → spin` pivots at each hub, and scales the
  model so its wheelbase matches the real car. Brake calipers steer but do not spin.
* **Nagao Touge** — from `Nagao map mod 0.4.9.zip` (a Unity 2022.3 `sharedassets` file). Only
  the world mesh `default_0` (617k vertices) and its atlas have usable data; the file has no
  scene transforms for the few small props, and 138 other mesh entries are empty stubs.
  `tools/convert_nagao.py` converts it (Unity left-handed Z-up → glTF), splits it into 500 m
  tiles for culling, writes 4K/2K atlases and a grip lookup (tarmac / grass / concrete), and
  `tools/compress-glb.mjs` applies meshopt compression (24 MB → 5.3 MB):

  ```bash
  python3 -m venv venv && venv/bin/pip install UnityPy numpy pillow
  venv/bin/python tools/convert_nagao.py "<path>/sharedassets18.assets.split0" out/
  node tools/compress-glb.mjs out/nagao_raw.glb public/assets/maps/nagao/nagao.glb
  ```
* **Forest Loop Raceway** — the uploaded `race_track__forest_loop_raceway.glb` contains no
  track geometry, only Sketchfab's placeholder image plane. The circuit is therefore generated
  procedurally (`ForestTrack.js`) in the style of that preview. Replace it with the real model
  when available.

Make sure you have the rights to redistribute the uploaded models and map before publishing.
