// Time of day: derives sky, fog and light settings for a map from its (daytime) definition.
// Night is deliberately bright (strong blue moonlight) so the road stays readable on a phone.

import * as THREE from 'three';

export const TIMES_OF_DAY = [['morning', 'Morning'], ['day', 'Day'], ['night', 'Night']];

const mix = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

/** @returns lighting for `map` (a MAPS entry) at `time` ('morning' | 'day' | 'night'). */
export function lightingFor(map, time) {
  const s = map.sky;
  const sun = new THREE.Vector3(...map.sun);
  const flat = new THREE.Vector3(sun.x, 0, sun.z).normalize();
  if (time === 'morning') {
    // Low, warm sun with an orange horizon and soft haze.
    return {
      skyTop: mix(s.top, 0x7e9fcf, 0.5), skyBottom: mix(s.bottom, 0xf3c08e, 0.65),
      fog: mix(s.fog, 0xe4c6a8, 0.6), fogDensity: s.fogDensity * 1.15,
      hemiSky: new THREE.Color(0xe6dccd), hemiGround: new THREE.Color(0x54463a), hemi: map.light.hemi * 0.95,
      sunColor: new THREE.Color(0xffc489), sun: map.light.sun * 0.95,
      sunDir: flat.multiplyScalar(0.96).setY(0.27).normalize(),
    };
  }
  if (time === 'night') {
    return {
      skyTop: new THREE.Color(0x0a1530), skyBottom: new THREE.Color(0x2b3d63),
      fog: new THREE.Color(0x1f2c47), fogDensity: s.fogDensity * 0.9,
      hemiSky: new THREE.Color(0x9fb6e6), hemiGround: new THREE.Color(0x2c3040), hemi: map.light.hemi * 0.62,
      sunColor: new THREE.Color(0xbfd0ff), sun: map.light.sun * 0.42,
      sunDir: flat.multiplyScalar(0.55).setY(0.83).normalize(),
    };
  }
  return {
    skyTop: new THREE.Color(s.top), skyBottom: new THREE.Color(s.bottom),
    fog: new THREE.Color(s.fog), fogDensity: s.fogDensity,
    hemiSky: new THREE.Color(0xdfe9f5), hemiGround: new THREE.Color(0x4a4a3a), hemi: map.light.hemi,
    sunColor: new THREE.Color(0xfff2dd), sun: map.light.sun,
    sunDir: sun.normalize(),
  };
}
