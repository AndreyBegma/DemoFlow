import { describe, expect, it } from 'vitest';
import {
  buildTimeMap,
  MAX_SYNC_OFFSET_MS,
  parseColour,
  type Rgb,
  SYNC_GRID,
  syncClearFrame,
  syncOffset,
  toOutputMs,
} from '../../src/index.ts';

const MAGENTA = parseColour('#ff00ff');
/** How VP8 decodes the mark (measured, #19). */
const DECODED: Rgb = [253, 0, 252];
const WHITE: Rgb = [253, 253, 253];
const APP: Rgb = [10, 6, 12];

/** A frame whose every cell is `colour`. */
function solid(colour: Rgb): Rgb[] {
  return Array.from({ length: SYNC_GRID * SYNC_GRID }, () => colour);
}

const MARK = { colour: '#ff00ff', onMs: 25, offMs: 180 };

describe('syncClearFrame', () => {
  it('finds the first frame after the mark, as VP8 decodes it', () => {
    const frames = [DECODED, DECODED, DECODED, WHITE, APP].map(solid);
    expect(syncClearFrame(frames, MAGENTA)).toBe(3);
  });

  it('skips frames before the mark', () => {
    const frames = [WHITE, DECODED, DECODED, APP].map(solid);
    expect(syncClearFrame(frames, MAGENTA)).toBe(3);
  });

  it('finds nothing when no frame shows the mark', () => {
    expect(syncClearFrame([WHITE, APP, APP].map(solid), MAGENTA)).toBe(
      undefined,
    );
    expect(syncClearFrame([], MAGENTA)).toBe(undefined);
  });

  it('finds nothing when the mark never clears', () => {
    expect(syncClearFrame([WHITE, DECODED, DECODED].map(solid), MAGENTA)).toBe(
      undefined,
    );
  });

  it('does not take a frame with some of the colour for the mark', () => {
    const partial = solid(DECODED);
    partial[5] = WHITE;
    expect(
      syncClearFrame([partial, partial, solid(APP)], MAGENTA),
    ).toBeUndefined();
  });

  it('accepts a cell within 64 levels per channel, and no further', () => {
    const near: Rgb = [255 - 64, 64, 255 - 64];
    const far: Rgb = [255 - 65, 0, 255];
    expect(syncClearFrame([near, WHITE].map(solid), MAGENTA)).toBe(1);
    expect(syncClearFrame([far, WHITE].map(solid), MAGENTA)).toBeUndefined();
  });
});

describe('syncOffset', () => {
  it('is the clear frame’s source time less offMs (Decision 4)', () => {
    expect(syncOffset(MARK, 120)).toBe(-60);
  });

  it('is not believed past ±500 ms, nor without a clear', () => {
    expect(syncOffset(MARK, MARK.offMs - MAX_SYNC_OFFSET_MS)).toBe(-500);
    expect(syncOffset(MARK, MARK.offMs - MAX_SYNC_OFFSET_MS - 1)).toBe(
      undefined,
    );
    expect(syncOffset(MARK, MARK.offMs + MAX_SYNC_OFFSET_MS + 1)).toBe(
      undefined,
    );
    expect(syncOffset(MARK, undefined)).toBe(undefined);
  });
});

describe('buildTimeMap from a start', () => {
  it('maps the start to output 0 and clips an idle stretch across it', () => {
    const map = buildTimeMap(
      [
        { startMs: 0, endMs: 100 },
        { startMs: 100, endMs: 2_000 },
      ],
      3_000,
      400,
      120,
    );
    expect(map[0]).toEqual({
      outputStartMs: 0,
      outputEndMs: 400,
      sourceStartMs: 120,
      sourceEndMs: 2_000,
    });
    expect(map.at(-1)).toEqual({
      outputStartMs: 400,
      outputEndMs: 1_400,
      sourceStartMs: 2_000,
      sourceEndMs: 3_000,
    });
    // Source before the start shows as output 0.
    expect(toOutputMs(map, 50)).toBe(0);
  });
});
