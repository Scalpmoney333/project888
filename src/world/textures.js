// Small procedural canvas textures (no external image assets needed).
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function noise(ctx, w, h, base, spread, count, seed, sizeMax = 2) {
  const r = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const v = Math.floor((r() - 0.5) * spread);
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
    const s = 1 + r() * sizeMax;
    ctx.fillRect(r() * w, r() * h, s, s);
  }
}

function finish(c, renderer, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
  return t;
}

export function asphaltTexture(renderer) {
  const [c, ctx] = canvas(512, 512);
  noise(ctx, 512, 512, '#3d3f41', 90, 26000, 7, 2);
  // wet sheen streaks
  const r = rng(3);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + r() * 0.04})`;
    ctx.fillRect(r() * 512, r() * 512, 20 + r() * 120, 2 + r() * 4);
  }
  // edge lines
  ctx.fillStyle = '#e8e8e2';
  ctx.fillRect(14, 0, 10, 512);
  ctx.fillRect(488, 0, 10, 512);
  // double yellow centre line
  ctx.fillStyle = '#e2b622';
  ctx.fillRect(247, 0, 7, 512);
  ctx.fillRect(258, 0, 7, 512);
  return finish(c, renderer);
}

export function kerbTexture(renderer) {
  const [c, ctx] = canvas(64, 256);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#f2f2f2' : '#c4161c';
    ctx.fillRect(0, i * 64, 64, 64);
  }
  return finish(c, renderer);
}

export function grassTexture(renderer) {
  const [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, '#3f5a26', 120, 9000, 11, 3);
  const r = rng(5);
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = `rgba(${90 + r() * 60},${110 + r() * 70},${40 + r() * 30},0.5)`;
    ctx.fillRect(r() * 256, r() * 256, 1, 3 + r() * 4);
  }
  return finish(c, renderer);
}

export function stoneTexture(renderer) {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#2d2620';
  ctx.fillRect(0, 0, 256, 256);
  const r = rng(9);
  for (let y = 0; y < 256; y += 22) {
    let x = -r() * 20;
    while (x < 256) {
      const w = 22 + r() * 22;
      const v = 70 + r() * 40;
      ctx.fillStyle = `rgb(${v + 10},${v},${v - 12})`;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + 11, w / 2 - 2, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      x += w;
    }
  }
  return finish(c, renderer);
}

export function chevronTexture(renderer) {
  const [c, ctx] = canvas(256, 64);
  ctx.fillStyle = '#e6c21a';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#151515';
  for (let i = -2; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 32, 0);
    ctx.lineTo(i * 32 + 16, 0);
    ctx.lineTo(i * 32 + 48, 64);
    ctx.lineTo(i * 32 + 32, 64);
    ctx.fill();
  }
  return finish(c, renderer);
}

export function metalTexture(renderer) {
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, '#d9dde0');
  g.addColorStop(0.5, '#8d9399');
  g.addColorStop(1, '#c7ccd0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return finish(c, renderer);
}

export function bannerTexture(renderer, text) {
  const [c, ctx] = canvas(1024, 128);
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 66);
  return finish(c, renderer, false);
}

export function startLineTexture(renderer) {
  const [c, ctx] = canvas(256, 32);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 2; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#111' : '#eee';
      ctx.fillRect(i * 16, j * 16, 16, 16);
    }
  }
  return finish(c, renderer, false);
}

/** Soft round sprite for smoke particles. */
export function smokeSprite() {
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}
