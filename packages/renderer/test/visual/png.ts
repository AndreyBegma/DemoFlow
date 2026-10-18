import { deflateSync, inflateSync } from 'node:zlib';
import type { Picture } from '../../src/ffmpeg/raster.ts';

/**
 * A minimal RGB PNG codec for the baselines: 8-bit truecolour, no interlace.
 * Encoding is a pure function of the pixels (fixed filter, fixed compression
 * level), so regenerating a baseline twice writes the same bytes.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** `picture` as PNG bytes. Every row uses the "Up" filter. */
export function encodePng(picture: Picture): Buffer {
  const { width, height, data } = picture;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 2;
    for (let i = 0; i < stride; i++) {
      const above = y === 0 ? 0 : data[(y - 1) * stride + i];
      raw[row + 1 + i] = (data[y * stride + i] - above) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** The pixels of an 8-bit RGB, non-interlaced PNG, with any scanline filter. */
export function decodePng(bytes: Uint8Array): Picture {
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 2 || body[12] !== 0) {
        throw new Error('only 8-bit RGB, non-interlaced PNGs are supported');
      }
    } else if (type === 'IDAT') {
      parts.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 3;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= 3 ? data[y * stride + i - 3] : 0;
      const up = y > 0 ? data[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 3 ? data[(y - 1) * stride + i - 3] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      data[y * stride + i] = (value + predicted) & 255;
    }
  }
  return { width, height, data };
}
