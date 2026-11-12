// Writes the 192x192 launcher icon (red disc, white racing stripe) as a PNG without dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

const N = 192;
const px = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  px[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const o = y * (N * 4 + 1) + 1 + x * 4;
    const dx = x - N / 2 + 0.5, dy = y - N / 2 + 0.5;
    const r = Math.hypot(dx, dy);
    let c = [13, 15, 18, 255];
    if (r < N * 0.46) c = [232, 68, 47, 255];
    if (r < N * 0.46 && Math.abs(dx + dy * 0.45) < N * 0.07) c = [255, 255, 255, 255];
    if (r >= N * 0.46 && r < N * 0.47) c = [120, 30, 20, 255];
    c.forEach((v, i) => (px[o + i] = v));
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
  return Buffer.concat([len, t, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(process.argv[2], { recursive: true });
fs.writeFileSync(`${process.argv[2]}/ic_launcher.png`, png);
