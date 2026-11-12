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
`npm run test:browser` (all maps and cars, start positions, wheel pivots, multitouch, cameras) and
`npm run test:ui` (menus, settings, manual gearbox buttons, HUD editor, persistence).
Screenshots go to `test-output/`.

## Android APK (and single HTML file)

```bash
npm run build:apk      # dist-single/touge-drift.apk (needs JDK 17 + Android SDK, see tools/build-apk.sh)
npm run build:single   # dist-single/touge-drift.html (everything embedded as base64, ~60 MB)
```

The APK is a fullscreen landscape WebView (`android/`) that serves the normal web build
(`dist/`) from its assets through a virtual `https://appassets.androidplatform.net` origin, so
cars and maps load on demand. The Android back button pauses the game. It is signed with a
locally generated key (`android/debug.keystore`, not committed), so Android asks to allow
installs from unknown sources. A rebuild on another machine has a different key and must be
installed after uninstalling the old app.

The single HTML file still works from a phone's storage, but with five cars and four maps it
is large; the APK is the recommended way to play on a phone.

## Controls

| Touch (landscape) | Keyboard | Gamepad |
| --- | --- | --- |
| Steering wheel (left, one full turn each way) or ◀ ▶ arrows | A/D or ←/→ | Left stick |
| GAS / BRAKE pedals — proportional (press higher for more) or regular on/off | W/S or ↑/↓ | RT / LT |
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
src/world/      maps.js (map list + loader for converted maps), textures.js
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

* **Cars** — the uploaded Sketchfab files are kept unmodified in `assets-src/cars/`.
  `tools/optimize-car.mjs` writes the runtime copies in `public/assets/cars/` (textures resized
  to ≤1024 px and re-encoded as WebP; geometry untouched). At load time `CarModel` bakes the node
  transforms, turns models authored facing another axis (Mark II, 240SX), finds the four wheels
  (by node list or name/material pattern, splitting meshes that hold several wheels into
  connected components), builds `wheelRoot → steer → spin` pivots at each hub, and scales the
  model so its wheelbase matches the real car. Wheels modelled with camber or toe (the 240SX
  fronts have 10.7° camber) are straightened so they spin about their real axle. Brake calipers
  steer but do not spin.
* **Maps** — Nagao, Tsukuba Winter and Ashinoko come from the uploaded Unity map mods
  (`sharedassets18.assets.split0`). Their world meshes carry no scene transforms, so they are
  converted as-is (Unity left-handed Z-up → glTF) by `tools/convert_unity_map.py`, configured
  in `tools/maps.json` (which meshes collide, grip per mesh or from the atlas colour, foliage).
  Tsukuba and Ashinoko store their scenery objects 3.3 m too high; the `liftFix` setting lowers
  every object onto the ground while leaving ground patches in place (`tools/maptools.py`).
  The converter tiles the geometry for culling, writes the atlas and finds the longest road to
  place two start points (Uphill/Downhill when the ends differ by more than 80 m).
  `tools/compress-glb.mjs` then applies meshopt compression:

  ```bash
  python3 -m venv venv && venv/bin/pip install UnityPy numpy scipy pillow texture2ddecoder
  venv/bin/python tools/convert_unity_map.py nagao "<folder with the extracted zip>" out/
  node tools/compress-glb.mjs out/nagao.raw.glb public/assets/maps/nagao.glb
  cp out/nagao.json out/nagao.jpg public/assets/maps/
  ```

* **GTA San Andreas mods** — `tools/gta/rw.py` reads RenderWare DFF/TXD files (including
  DXT1/3/5 textures). `tools/gta/convert_gta_map.py` turns Shomaru Touge (IPL placements +
  30 DFF pieces + TXD) into a map with per-texture materials (rules in `tools/gta/gta_maps.json`);
  `tools/gta/convert_gta_car.py` turns the Mark II JZX100 DFF/TXD into a glb, copying GTA's single
  wheel model to the four wheel positions. The car is then simplified for phones
  (562k → 171k triangles):

  ```bash
  venv/bin/python tools/gta/convert_gta_map.py shomaru "<Shomaru Touge/Shomaru>" out/
  node tools/compress-glb.mjs out/shomaru.raw.glb public/assets/maps/shomaru.glb
  venv/bin/python tools/gta/convert_gta_car.py "<folder with 1_d.dff, 1_d.txd>" out/mark2.glb
  node tools/optimize-car.mjs out/mark2.glb public/assets/cars/toyota_mark_ii_jzx100_gta.glb --simplify 0.2 0.0012
  ```

  The car archive is RAR5; extract it with RARLAB `unrar` (p7zip and unar fail on it).

  Forest Loop Raceway (no track geometry in its file) and Oi Wharf were removed.

Make sure you have the rights to redistribute the uploaded models and map before publishing.
