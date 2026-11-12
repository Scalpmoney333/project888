// Asset URL resolver. In the single-file build (tools/build-single.mjs) every asset is embedded
// in the HTML as a base64 <script type="application/octet-stream" data-asset="path"> tag; it
// is decoded into a Blob URL on first use, so the game works from file:// and inside an APK
// WebView where fetching relative files is not possible.

const cache = new Map();

function embedded(path) {
  return document.querySelector(`script[data-asset="${CSS.escape(path)}"]`);
}

export const isSingleFile = () => !!document.querySelector('script[data-asset]');

/** True when the asset can be loaded (always true in the normal multi-file build). */
export function hasAsset(path) {
  return !isSingleFile() || cache.has(path) || !!embedded(path);
}

export function assetUrl(path) {
  if (cache.has(path)) return cache.get(path);
  const el = embedded(path);
  if (!el) return path;
  const bin = atob(el.textContent.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: el.dataset.type || 'application/octet-stream' }));
  cache.set(path, url);
  el.remove(); // free the base64 text
  return url;
}
