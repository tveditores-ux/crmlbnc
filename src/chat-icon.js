'use strict';
const zlib = require('node:zlib');

/**
 * Ícono de la app del chat de líderes (PNG generado en memoria, sin archivos binarios en el repo):
 * fondo esmeralda con una gema clara en el centro, en la línea del avatar de Grace.
 * Se genera una vez por tamaño y queda en caché.
 */

const cache = new Map();

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function iconPng(size) {
  if (cache.has(size)) return cache.get(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.30; // radio de la gema (rombo)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filtro: ninguno
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size); // degradado diagonal esmeralda
      let R = Math.round(2 + t * 4);
      let G = Math.round(44 + t * 34);
      let B = Math.round(34 + t * 26);
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < r) {
        // gema: faceta superior más clara, inferior más profunda
        const arriba = y < cy;
        const f = 1 - d / r;
        if (arriba) {
          R = Math.round(167 + f * 60);
          G = Math.round(243);
          B = Math.round(208 + f * 30);
        } else {
          R = Math.round(16 + f * 40);
          G = Math.round(185 - f * 40);
          B = Math.round(129 - f * 30);
        }
      }
      const o = rowStart + 1 + x * 4;
      raw[o] = R;
      raw[o + 1] = G;
      raw[o + 2] = B;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = 6; // color RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  cache.set(size, png);
  return png;
}

module.exports = { iconPng };
