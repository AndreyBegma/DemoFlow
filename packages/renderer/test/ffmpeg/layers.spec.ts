import { describe, expect, it } from 'vitest';
import { mix, sourcesOf } from '../../src/ffmpeg/layers.ts';
import { createPicture } from '../../src/ffmpeg/raster.ts';
import type { FrameState } from '../../src/index.ts';

function state(sourceMs: number | null, from?: FrameState): FrameState {
  return {
    sourceMs,
    crop: { x: 0, y: 0, width: 4, height: 2 },
    content: { x: 0, y: 0, width: 4, height: 2 },
    scale: 1,
    rings: [],
    masks: [],
    watermark: false,
    ...(from === undefined ? {} : { fade: { from, progress: 0.5 } }),
  };
}

describe('dissolve layers (spec 114)', () => {
  it('names the source times deepest first, the order a forward-only decoder needs', () => {
    // A card over a page that is dissolving from a held frame.
    expect(sourcesOf(state(null, state(2400, state(1950))))).toEqual([
      1950, 2400,
    ]);
    expect(sourcesOf(state(null))).toEqual([]);
  });

  it('mixes the frame over the one under it by progress', () => {
    const target = createPicture(1, 1);
    const under = createPicture(1, 1);
    target.data.set([200, 100, 0]);
    under.data.set([0, 100, 200]);
    mix(target, under, 0.25);
    expect([...target.data]).toEqual([50, 100, 150]);

    target.data.set([200, 100, 0]);
    mix(target, under, 0);
    expect([...target.data]).toEqual([0, 100, 200]);

    target.data.set([200, 100, 0]);
    mix(target, under, 1);
    expect([...target.data]).toEqual([200, 100, 0]);
  });
});
