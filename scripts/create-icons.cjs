'use strict';

// Deterministic, original bitmap assets; no external image service is required.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      const inside = nx > 0.08 && nx < 0.92 && ny > 0.08 && ny < 0.92;
      let color = [35, 60, 45, inside ? 255 : 0];
      if (nx > 0.26 && nx < 0.74 && ny > 0.22 && ny < 0.79) color = [197, 226, 187, 255];
      if (
        nx > 0.35 &&
        nx < 0.65 &&
        ((ny > 0.38 && ny < 0.42) || (ny > 0.5 && ny < 0.54) || (ny > 0.62 && ny < 0.66))
      )
        color = [61, 99, 72, 255];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const directory = path.join(__dirname, '..', 'assets');
fs.mkdirSync(directory, { recursive: true });
const image = png(256);
fs.writeFileSync(path.join(directory, 'app.png'), image);
fs.writeFileSync(path.join(directory, 'tray.png'), png(32));
const icon = Buffer.alloc(22);
icon.writeUInt16LE(1, 2);
icon.writeUInt16LE(1, 4);
icon.writeUInt16LE(1, 10);
icon.writeUInt16LE(32, 12);
icon.writeUInt32LE(image.length, 14);
icon.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(directory, 'app.ico'), Buffer.concat([icon, image]));
console.log('Created app.png, tray.png, and app.ico.');
