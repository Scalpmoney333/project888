// Build one self-contained HTML file (JS, CSS, car models and map data embedded).
// Usage: npm run build:single   ->  dist-single/touge-drift.html
// The file opens directly from a phone's storage (file:// / content://) or inside the APK
// WebView; nothing is fetched over the network.

import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tmp = path.join(root, 'dist-single', '.tmp');
const out = path.join(root, 'dist-single', 'touge-drift.html');

// Every file under public/assets is embedded (cars and maps), so the result is large (~60 MB);
// the APK (tools/build-apk.sh) is the better way to run on phones.
const TYPES = { glb: 'model/gltf-binary', jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png', json: 'application/json' };
const ASSETS = fs.readdirSync(path.join(root, 'public/assets'), { recursive: true })
  .filter((f) => TYPES[f.split('.').pop()])
  .map((f) => [`assets/${f.split(path.sep).join('/')}`, TYPES[f.split('.').pop()]]);

await build({ root, logLevel: 'warn', build: { outDir: tmp, emptyOutDir: true, copyPublicDir: false, modulePreload: false } });

let html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(tmp, rel.replace(/^\.?\//, '')), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>${read(href)}</style>`);
const scripts = [];
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  // "</script" inside the bundle would end the inline tag early.
  scripts.push(read(src).replace(/<\/script/gi, '<\\/script'));
  return '';
});
if (!scripts.length) throw new Error('no module script found in built index.html');

const data = ASSETS.map(([rel, type]) => {
  const b64 = fs.readFileSync(path.join(root, 'public', rel)).toString('base64');
  return `<script type="application/octet-stream" data-asset="${rel}" data-type="${type}">${b64}</script>`;
}).join('\n');

// Asset data first (module scripts run after parsing anyway), then the game.
// Function replacement: the bundle contains "$'" style sequences String.replace would expand.
html = html.replace('</body>', () => `${data}\n<script type="module">${scripts.join('\n')}</script>\n</body>`);
fs.writeFileSync(out, html);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(root, out)}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
