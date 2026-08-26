const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xEDB88320 ^ (v >>> 1) : v >>> 1;
      table[n] = v;
    }
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tc = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tc));
    return Buffer.concat([len, tc, crc]);
  }

  // Build raw pixel data (RGBA) with filter byte per row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      // Rounded rect with gradient
      const r = 32;
      const corner = (
        (x < r && y < r && (x-r)**2 + (y-r)**2 > r*r) ||
        (x >= width-r && y < r && (x-width+r+1)**2 + (y-r)**2 > r*r) ||
        (x < r && y >= height-r && (x-r)**2 + (y-height+r+1)**2 > r*r) ||
        (x >= width-r && y >= height-r && (x-width+r+1)**2 + (y-height+r+1)**2 > r*r)
      );
      if (!corner) {
        const t = (x + y) / (width + height);
        raw[px]   = (99 + t * 40) | 0;   // R: 99->139
        raw[px+1] = (102 - t * 10) | 0;  // G: 102->92
        raw[px+2] = (241 + t * 5) | 0;   // B: 241->246
        raw[px+3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const deflated = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const png = createPNG(256, 256);
fs.writeFileSync(path.join(assetsDir, 'logo.png'), png);
fs.writeFileSync(path.join(assetsDir, 'icon.png'), png);
console.log(`Created logo.png and icon.png (${png.length} bytes)`);
