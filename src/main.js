import './styles.css';
import { Game } from './core/Game.js';
import { UI } from './ui/UI.js';
import { settings, applyPreset } from './core/settings.js';

// First launch: pick graphics defaults suited to this device.
if (!settings.data.graphics.initialized) {
  applyPreset('auto');
  settings.set('graphics.initialized', true);
}

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
let game;
try {
  game = new Game(canvas, uiRoot);
} catch (err) {
  uiRoot.innerHTML = `<div class="overlay"><div class="panel small"><h2>WebGL unavailable</h2><p>${err.message}</p></div></div>`;
  throw err;
}
const ui = new UI(uiRoot, game);

// Exposed for debugging and automated browser tests.
window.__drift = { game, ui, settings };

// Prevent pinch-zoom / double-tap zoom and pull-to-refresh on mobile while driving.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
