/**
 * Reads the video frame size from a WebM file's EBML header
 * (Segment → Tracks → TrackEntry → Video → PixelWidth / PixelHeight).
 * A test helper: the engine itself never parses recordings.
 */

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;

/** Master elements the walk descends into, on the way to Video. */
const CONTAINERS = new Set([SEGMENT, TRACKS, TRACK_ENTRY, VIDEO]);

export interface FrameSize {
  width: number;
  height: number;
}

interface Header {
  id: number;
  /** Payload length; `undefined` for an unknown-size element. */
  size: number | undefined;
  /** Offset of the payload. */
  start: number;
}

/** An element id keeps its length-marker bits; it is compared as written. */
function readHeader(buf: Buffer, offset: number): Header | undefined {
  const first = buf[offset];
  if (first === undefined || first === 0) return undefined;
  const idLength = Math.clz32(first) - 24 + 1;
  if (idLength > 4 || offset + idLength > buf.length) return undefined;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + (buf[offset + i] ?? 0);

  const sizeOffset = offset + idLength;
  const sizeFirst = buf[sizeOffset];
  if (sizeFirst === undefined || sizeFirst === 0) return undefined;
  const sizeLength = Math.clz32(sizeFirst) - 24 + 1;
  if (sizeOffset + sizeLength > buf.length) return undefined;
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = buf[sizeOffset + i] ?? 0;
    if (byte !== 0xff) allOnes = false;
    size = size * 256 + byte;
  }
  return {
    id,
    size: allOnes ? undefined : size,
    start: sizeOffset + sizeLength,
  };
}

function readUint(buf: Buffer, start: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (buf[start + i] ?? 0);
  return value;
}

/** Walks `[from, to)`, descending into the containers on the path to Video. */
function findFrameSize(
  buf: Buffer,
  from: number,
  to: number,
): FrameSize | undefined {
  let width: number | undefined;
  let height: number | undefined;
  let offset = from;
  while (offset < to) {
    const header = readHeader(buf, offset);
    if (!header) return undefined;
    const end = header.size === undefined ? to : header.start + header.size;
    if (CONTAINERS.has(header.id)) {
      const found = findFrameSize(buf, header.start, Math.min(end, to));
      if (found) return found;
    } else if (header.id === PIXEL_WIDTH && header.size !== undefined) {
      width = readUint(buf, header.start, header.size);
    } else if (header.id === PIXEL_HEIGHT && header.size !== undefined) {
      height = readUint(buf, header.start, header.size);
    }
    if (header.size === undefined) return undefined;
    offset = end;
  }
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

export function webmFrameSize(file: Buffer): FrameSize {
  const size = findFrameSize(file, 0, file.length);
  if (!size) throw new Error('no video PixelWidth/PixelHeight in the WebM');
  return size;
}
