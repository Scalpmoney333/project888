// Game orchestration: rendering, session (car + map) loading, the frame loop, effects, audio
// and recovery. Physics runs at a fixed 240 Hz inside Vehicle.update().

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { settings, resolveGraphics, vibrate } from './settings.js';
import { assetUrl } from './assets.js';
import { CollisionWorld } from '../physics/CollisionWorld.js';
import { Vehicle } from '../physics/Vehicle.js';
import { getVehicle, buildSpec } from '../vehicle/specs.js';
import { CarModel } from '../vehicle/CarModel.js';
import { MAPS, loadMap } from '../world/maps.js';
import { CameraRig } from '../camera/CameraRig.js';
import { DroneCamera } from '../camera/Drone.js';
import { Input } from '../input/Input.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { SmokeSystem, SkidMarks, ExhaustFlames } from '../fx/Effects.js';

export { MAPS };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const DUST_BROWN = [0.48, 0.4, 0.3];
const PARKED = { steer: 0, throttle: 0, brake: 0, handbrake: 1, clutch: 0 };
const DRONE_IDLE = { forward: 0, right: 0, up: 0, fast: false };

export class Game {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.gfx = resolveGraphics();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.gfx.preset !== 'low', powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 4000);
    this.dynamicScale = 1;
    this.paused = true;
    this.session = null;
    this.listeners = {};
    this.frameTimes = [];
    this.fps = 60;
    this.score = { total: 0, current: 0, combo: 1, timer: 0, best: 0 };

    // lights
    this.hemi = new THREE.HemisphereLight(0xdfe9f5, 0x4a4a3a, 1.5);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    this.sun.shadow.camera.left = -22;
    this.sun.shadow.camera.right = 22;
    this.sun.shadow.camera.top = 22;
    this.sun.shadow.camera.bottom = -22;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    // sky dome
    this.skyUniforms = { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        vertexShader: 'varying vec3 vP; void main(){ vP = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
        fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y*1.6+0.15,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }',
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.input = new Input(uiRoot);
    this.audio = new AudioEngine();
    this.smoke = new SmokeSystem(this.scene, this.gfx.smoke);
    this.skids = new SkidMarks(this.scene, this.gfx.preset);
    this.input.on('camera', () => this.cameraRig?.next());
    this.input.on('reset', () => this.resetCar());
    this.input.on('gearUp', () => this.shift(1));
    this.input.on('gearDown', () => this.shift(-1));
    this.input.on('pause', () => this.emit('pause'));
    this.input.on('drone', () => this.setDrone(true));
    this.input.on('droneExit', () => this.setDrone(false));
    this.input.on('hudToggle', () => this.setHudHidden(!this.input.hudHidden));
    // Drag on empty screen: free look while driving (eases back after release), aim in drone mode.
    this.input.onLook = (dx, dy) => {
      if (this.drone?.active) this.drone.look(dx, -dy);
      else this.cameraRig?.lookBy(-dx, dy);
    };
    this.input.onLookHeld = (held) => this.cameraRig?.setLookHeld(held);

    settings.onChange((path) => this.onSettings(path));
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.emit('pause'); this.audio.suspend(); }
    });
    this.applyGraphics();
    this.resize();
    this.last = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
  }

  emit(evt, data) {
    for (const fn of this.listeners[evt] || []) fn(data);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  pixelRatio() {
    return Math.max(0.4, Math.min(devicePixelRatio || 1, this.gfx.maxDpr) * this.gfx.pixelRatio * this.dynamicScale);
  }

  applyGraphics() {
    const prev = this.gfx;
    this.gfx = resolveGraphics();
    const g = this.gfx;
    this.renderer.shadowMap.enabled = g.shadows;
    this.sun.castShadow = g.shadows;
    if (g.shadows && this.sun.shadow.mapSize.x !== g.shadowSize) {
      this.sun.shadow.mapSize.set(g.shadowSize, g.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.renderer.shadowMap.type = g.preset === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true)); });
    this.scene.environment = g.reflections ? this.envMap : null;
    if (prev.smoke !== g.smoke || !this.smoke) this.smoke.setQuality(g.smoke);
    if (!g.skidmarks) this.skids.clear();
    this.dynamicScale = 1;
    this.resize();
  }

  onSettings(path) {
    if (path.startsWith('graphics')) this.applyGraphics();
    if (path.startsWith('assists') && this.vehicle) Object.assign(this.vehicle.assists, settings.data.assists);
    if (path.startsWith('driving') && this.vehicle) this.applyDriving();
    if (path.startsWith('tuning') && this.vehicle) this.applyTuning();
    if (path.startsWith('paint') && this.model) this.model.setPaint(this.paintFor(this.carDef));
  }

  /** Chosen repaint, else the car's factory colour (null keeps the model's own materials). */
  paintFor(def) {
    return settings.data.paint[def.id] || def.defaultPaint || null;
  }

  applyDriving() {
    const t = settings.data.driving.transmission;
    this.vehicle.transmission = t;
    this.vehicle.drivetrain.spec.autoBlip = t === 'auto';
    if (t === 'auto' && this.vehicle.gear === 0) this.vehicle.drivetrain.requestGear(1, 0);
  }

  tuningFor(def) {
    return { trackWidth: this.model ? +this.model.measured.trackWidth.toFixed(3) : def.defaults.trackWidth, ...(settings.data.tuning[def.id] || {}) };
  }

  applyTuning() {
    const spec = buildSpec(this.carDef, this.tuningFor(this.carDef), this.model.measured);
    this.vehicle.applySpec(spec);
    this.vehicle.drivetrain.spec.autoBlip = this.vehicle.transmission === 'auto';
  }

  // ---------------- session ----------------
  async loadSession(carId, mapId, onProgress = () => {}) {
    this.paused = true;
    this.setDrone(false);
    const mapDef = MAPS.find((m) => m.id === mapId) || MAPS[0];
    const carDef = getVehicle(carId);
    const quality = this.gfx.preset;

    if (!this.map || this.map.id !== mapDef.id) {
      onProgress(0.05, 'Loading map…');
      if (this.map) { this.scene.remove(this.map.group); this.map.dispose(); }
      this.map = null;
      const map = await loadMap(mapDef, { renderer: this.renderer, quality, onProgress: (p) => onProgress(0.05 + p * 0.5, 'Loading map…') });
      onProgress(0.6, 'Building collision…');
      await new Promise((r) => setTimeout(r, 0));
      this.world = new CollisionWorld();
      for (const g of map.collision) this.world.addGeometry(g);
      for (const c of map.cylinders) this.world.addCylinder(...c);
      this.scene.add(map.group);
      this.map = map;
      this.skyUniforms.top.value.set(map.sky.top);
      this.skyUniforms.bottom.value.set(map.sky.bottom);
      this.scene.fog = new THREE.FogExp2(map.sky.fog, map.sky.fogDensity);
      this.scene.background = new THREE.Color(map.sky.fog);
      this.hemi.intensity = map.lightIntensity.hemi;
      this.sun.intensity = map.lightIntensity.sun;
      this.camera.far = map.far;
      this.camera.updateProjectionMatrix();
      this.sky.scale.setScalar(map.far * 0.9);
      this.cameraRig = new CameraRig(this.camera, this.world);
      this.drone = new DroneCamera(this.camera, this.world);
    }

    if (!this.model || this.carDef.id !== carDef.id) {
      onProgress(0.7, 'Loading car…');
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(assetUrl(carDef.url), (e) => onProgress(0.7 + (e.total ? e.loaded / e.total : 0) * 0.25, 'Loading car…'));
      if (this.model) { this.scene.remove(this.model.root); this.model.dispose(); }
      this.model = new CarModel(gltf, carDef, quality);
      this.carDef = carDef;
      this.model.setPaint(this.paintFor(carDef));
      this.scene.add(this.model.root);
      this.flames = new ExhaustFlames(this.model.body, this.model.exhausts);
    }
    const spec = buildSpec(carDef, this.tuningFor(carDef), this.model.measured);
    this.vehicle = new Vehicle(spec, this.world);
    Object.assign(this.vehicle.assists, settings.data.assists);
    this.applyDriving();
    this.resetCar();
    this.cameraRig.mode = settings.data.camera.mode;
    onProgress(1, 'Ready');
    this.emit('session', { car: carDef, map: mapDef });
  }

  /** Spawn point chosen for the current map (Uphill/Downhill etc.). */
  currentSpawn() {
    const spawns = this.map.spawns;
    const id = settings.data.spawn[this.map.id];
    return spawns.find((s) => s.id === id) || spawns[0];
  }

  setSpawn(id) {
    settings.set(`spawn.${this.map.id}`, id);
    this.resetCar();
  }

  resetCar() {
    if (!this.vehicle) return;
    const s = this.currentSpawn();
    this.vehicle.reset(s.position, s.yaw);
    this.vehicle.drivetrain.spec.autoBlip = this.vehicle.transmission === 'auto';
    this.cameraRig.snap();
    this.smoke.clear();
    this.skids.clear();
    this.score.current = 0;
    this.score.combo = 1;
    this.flipTimer = 0;
  }

  shift(dir) {
    const v = this.vehicle;
    if (!v || this.paused) return;
    if (v.transmission !== 'manual') return;
    if (dir > 0) v.drivetrain.shiftUp(v.speed);
    else v.drivetrain.shiftDown(v.speed);
  }

  setPaused(p) {
    this.paused = p;
    if (p) { this.input.release(); this.audio.suspend(); } else { this.audio.init(); this.audio.resume(); }
  }

  /** Free-flying drone camera; the car is parked with the handbrake while it is active. */
  setDrone(on) {
    if (!this.drone || on === this.drone.active) return;
    if (on) this.drone.start();
    else { this.drone.stop(); this.cameraRig.snap(); }
    this.input.setMode(on ? 'drone' : 'drive');
    this.emit('hud', false);
    this.emit('drone', on);
  }

  setHudHidden(hidden) {
    this.input.hudHidden = hidden;
    this.input.layout();
    this.emit('hud', hidden);
  }

  // ---------------- frame ----------------
  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.trackPerformance(dt);
    if (this.vehicle && this.map) {
      if (!this.paused) this.simulate(dt);
      this.updateVisuals(dt);
    }
    if (this.map) this.renderer.render(this.scene, this.camera);
  }

  simulate(dt) {
    const v = this.vehicle;
    const inp = this.drone.active ? PARKED : this.input.update(dt);
    const c = v.controls;
    c.steer = inp.steer;
    c.throttle = inp.throttle;
    c.brake = inp.brake;
    c.handbrake = inp.handbrake;
    c.clutch = settings.data.driving.transmission === 'manual' && settings.data.driving.clutchPedal ? inp.clutch : null;
    const prevHb = this.prevHandbrake || 0;
    const prevThrottle = this.prevThrottle || 0;
    const prevShifts = v.drivetrain.shiftEvents;
    v.update(dt);

    // sounds / triggers
    if (inp.handbrake > 0.5 && prevHb <= 0.5) this.audio.handbrake(true);
    if (inp.handbrake < 0.2 && prevHb >= 0.2) this.audio.handbrake(false);
    this.prevHandbrake = inp.handbrake;
    if (v.drivetrain.shiftEvents !== prevShifts) this.audio.shift();
    if (v.impact > 900) {
      const s = v.impact / 9000;
      this.audio.impact(s);
      this.cameraRig.addTrauma(Math.min(0.8, s));
      vibrate(Math.min(80, 20 + s * 80));
      this.score.current = 0;
      this.score.combo = 1;
    }
    v.impact = 0;
    if (v.suspensionHit > 1.3) this.audio.suspension(v.suspensionHit);
    v.suspensionHit = 0;
    // backfire on lift-off at high revs
    if (prevThrottle > 0.7 && inp.throttle < 0.25 && v.rpm > v.spec.engine.redlineRpm * 0.6) {
      const pops = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < pops; i++) setTimeout(() => this.backfire(), i * (60 + Math.random() * 90));
    }
    if (v.drivetrain.limiterCut > 0.05 && Math.random() < 0.08) this.backfire();
    this.prevThrottle = inp.throttle;

    // recovery: flipped or fell out of the world
    const up = _v.set(0, 1, 0).applyQuaternion(v.quaternion).y;
    this.flipTimer = up < 0.25 && Math.abs(v.speed) < 3 ? (this.flipTimer || 0) + dt : 0;
    if (this.flipTimer > 2.5) {
      const yaw = Math.atan2(_v.set(0, 0, 1).applyQuaternion(v.quaternion).x, _v.z);
      v.reset(v.position.clone().add(new THREE.Vector3(0, 1.5, 0)), yaw);
      this.flipTimer = 0;
    }
    if (v.position.y < this.world.minY - 40) this.resetCar();

    this.updateScore(dt);
  }

  backfire() {
    if (!this.vehicle) return;
    this.audio.backfire();
    if (this.gfx.exhaust) {
      this.flames?.pop();
      const v = this.vehicle;
      for (const tip of this.model.exhausts) {
        const p = _v.copy(tip).add(this.model.body.position).applyQuaternion(v.renderQuaternion).add(v.renderPosition);
        this.smoke.emit(p.x, p.y, p.z, v.velocity.x * 0.6, 0.3, v.velocity.z * 0.6, 0.35, 0.35, 0.9, 0.35, 0.35, 0.35, 3);
      }
    }
  }

  updateScore(dt) {
    const v = this.vehicle;
    const sc = this.score;
    const beta = Math.abs(v.driftAngle);
    const kmh = v.speed * 3.6;
    if (beta > 0.17 && kmh > 20 && v.airTime < 0.3) {
      sc.current += dt * (beta * 57.3) * (kmh / 30) * sc.combo * 2;
      sc.timer = 1.4;
      sc.combo = Math.min(5, sc.combo + dt * 0.25);
    } else if (sc.timer > 0) {
      sc.timer -= dt;
      if (sc.timer <= 0) {
        sc.total += Math.round(sc.current);
        sc.best = Math.max(sc.best, Math.round(sc.current));
        sc.current = 0;
        sc.combo = 1;
      }
    }
  }

  updateVisuals(dt) {
    const v = this.vehicle;
    const braking = v.controls.brake > 0.1 || (v.transmission === 'auto' && v.gear === -1 && v.controls.throttle > 0.1);
    this.model.update(v, braking);
    if (this.drone.active) this.drone.update(dt, this.paused ? DRONE_IDLE : this.input.droneInput());
    else this.cameraRig.update(dt, v, this.model);
    this.sky.position.copy(this.camera.position);

    // sun + shadow follow the car
    const sunDir = this.map.sun;
    this.sun.target.position.copy(v.renderPosition);
    this.sun.position.copy(v.renderPosition).addScaledVector(sunDir, 70);

    // ---- tire effects ----
    let squeal = 0, rumble = 0;
    if (!this.paused) {
      const rate = { off: 0, low: 25, medium: 55, high: 95 }[this.gfx.smoke] || 0;
      this.smokeAcc ||= [0, 0, 0, 0];
      for (const w of v.wheels) {
        if (!w.contact || !w.surface) { this.skids.add(w.index, w.point, w.normal, _side, 0, 0); continue; }
        const surf = w.surface;
        const slip = w.slipSpeed;
        const loadF = Math.min(1.3, w.load / 3500);
        const smokeI = smooth(3.5, 13, slip) * loadF * surf.smoke * (w.front ? 0.35 : 1);
        const dustI = surf.dust * smooth(1, 8, Math.max(slip, Math.abs(v.speed) * 0.5));
        squeal = Math.max(squeal, smooth(2.2, 11, slip) * surf.skid * Math.min(1, loadF + 0.2));
        rumble = Math.max(rumble, (surf.bump > 0.005 ? 1 : 0.15) * Math.min(1, Math.abs(v.speed) / 15));
        if (rate && (smokeI > 0.02 || dustI > 0.05)) {
          this.smokeAcc[w.index] += dt * rate * Math.max(smokeI, dustI * 0.7);
          while (this.smokeAcc[w.index] >= 1) {
            this.smokeAcc[w.index] -= 1;
            const r = () => (Math.random() - 0.5) * 1.2;
            const p = w.point;
            if (smokeI >= dustI * 0.7) {
              const shade = 0.82 + Math.random() * 0.12;
              this.smoke.emit(p.x + r() * 0.3, p.y + 0.25, p.z + r() * 0.3, v.velocity.x * 0.25 + r(), 0.4 + Math.random() * 0.6, v.velocity.z * 0.25 + r(), 0.9 + smokeI * 0.6, 0.35 + smokeI * 0.35, 1.8 + smokeI * 1.6, shade, shade, shade);
            } else {
              const dc = surf.dustColor || DUST_BROWN;
              this.smoke.emit(p.x + r() * 0.3, p.y + 0.15, p.z + r() * 0.3, v.velocity.x * 0.3 + r(), 0.3, v.velocity.z * 0.3 + r(), 0.7, 0.4 * dustI, 1.3, dc[0], dc[1], dc[2], 1.6);
            }
          }
        }
        if (this.gfx.skidmarks) {
          const skidI = surf.skid * smooth(2.5, 9, slip) * Math.min(1, loadF + 0.2);
          _side.set(1, 0, 0).applyQuaternion(v.quaternion);
          this.skids.add(w.index, w.point, w.normal, _side, 0.22, skidI);
        }
      }
    }
    this.smoke.update(dt, this.camera, this.renderer);
    this.skids.update();
    this.flames?.update(dt);
    this.audio.update({
      rpm: v.rpm,
      throttle: v.drivetrain.throttleApplied,
      squeal: this.paused ? 0 : squeal,
      rumble: this.paused ? 0 : rumble,
      speed: Math.abs(v.speed),
      cylinders: 6,
    });
    this.emit('frame', v);
  }

  /** Adaptive resolution: lower the render scale when FPS stays low, raise it when there is headroom. */
  trackPerformance(dt) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 60) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    this.fps = 1 / avg;
    if (!this.gfx.adaptive || this.paused) return;
    let next = this.dynamicScale;
    if (this.fps < 27) next = Math.max(0.55, this.dynamicScale - 0.1);
    else if (this.fps > 50 && this.dynamicScale < 1) next = Math.min(1, this.dynamicScale + 0.05);
    if (next !== this.dynamicScale) {
      this.dynamicScale = next;
      this.resize();
    }
  }
}
