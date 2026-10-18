import { readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createPicture, type Picture } from '../../src/ffmpeg/raster.ts';
import { baselinePath, failurePath } from './baselines.ts';
import { comparePictures, type Tolerance } from './compare.ts';
import { checkLayout } from './layout.ts';
import { decodePng, encodePng } from './png.ts';
import { renderScene, SCENES, syntheticSource } from './scenes.ts';

/**
 * Set from measurement (spec 73, decision 3): just above the largest
 * difference seen between Linux, macOS and Windows. The numbers each run
 * observed are logged below as `baseline <name>: …`.
 */
const TOLERANCE: Tolerance = { pixel: 2, share: 0.0005 };

const SOURCE = syntheticSource();

describe('golden images of the compositor', () => {
  for (const scene of SCENES) {
    it(`draws the ${scene.name} as its baseline`, async () => {
      const actual = renderScene(scene, SOURCE);
      const expected = decodePng(await readFile(baselinePath(scene.name)));
      const result = comparePictures(actual, expected, TOLERANCE);
      console.info(
        `baseline ${scene.name}: max delta ${result.maxDelta}, ` +
          `${result.differing} px over ${TOLERANCE.pixel} ` +
          `(${(result.share * 100).toFixed(4)} %, allowed ${TOLERANCE.share * 100} %)`,
      );
      if (!result.ok && result.diff !== undefined) {
        await writeFile(failurePath(scene.name, 'actual'), encodePng(actual));
        await writeFile(
          failurePath(scene.name, 'diff'),
          encodePng(result.diff),
        );
      }
      expect(
        result.ok,
        `${scene.name} differs from its baseline; see ${failurePath(scene.name, 'diff')}`,
      ).toBe(true);
    });
  }

  it('fails on a one-pixel-wide change in the cursor colour, with a diff image', async () => {
    const scene = SCENES.find((s) => s.name === 'cursor');
    if (scene === undefined) throw new Error('no cursor scene');
    const expected = decodePng(await readFile(baselinePath('cursor')));
    const actual = renderScene(scene, SOURCE);
    // The cursor's tip is at (40, 40) in the kept region; at scale 1.5 its
    // white body is solid from about x = 44. Recolour one column of it.
    const column = 46;
    for (let y = 56; y < 76; y++) {
      const at = (y * actual.width + column) * 3;
      actual.data[at] = 255;
      actual.data[at + 1] = 0;
      actual.data[at + 2] = 0;
    }
    const result = comparePictures(actual, expected, TOLERANCE);
    expect(result.ok).toBe(false);
    expect(result.differing).toBe(20);
    expect(result.diff).toBeDefined();
    // The diff image marks exactly those pixels, and survives a PNG round trip.
    const file = failurePath('cursor-mutation', 'diff');
    await writeFile(file, encodePng(result.diff as Picture));
    const diff = decodePng(await readFile(file));
    await rm(file);
    let marked = 0;
    for (let at = 0; at < diff.data.length; at += 3) {
      if (diff.data[at] === 255 && diff.data[at + 1] === 0) marked++;
    }
    expect(marked).toBe(20);
  });

  it('fails when the picture has another size than the baseline', () => {
    const result = comparePictures(
      createPicture(10, 10),
      createPicture(10, 12),
      TOLERANCE,
    );
    expect(result.ok).toBe(false);
  });
});

describe('the PNG codec', () => {
  it('round-trips a picture exactly and encodes it the same way twice', () => {
    const picture = renderScene(SCENES[0], SOURCE);
    const bytes = encodePng(picture);
    expect(decodePng(bytes)).toEqual(picture);
    expect(encodePng(picture).equals(bytes)).toBe(true);
  });
});

describe('the layout check (#47)', () => {
  const { width, height } = { width: 1920, height: 1080 };

  /** The page filling the frame, as the compositor draws one. */
  function fullFrame(): Uint8Array {
    return renderScene(
      {
        name: 'full',
        frame: SCENES[0].frame,
        region: { x: 0, y: 0, width, height },
      },
      SOURCE,
    ).data;
  }

  it('passes a page that fills the frame', () => {
    const report = checkLayout(fullFrame(), width, height);
    expect(report.problems).toEqual([]);
    expect(report.paddingShare).toBe(0);
  });

  it('fails a frame with the page in its top-left quarter and padding grey elsewhere', () => {
    // The #47 shape: a recording at half size, the rest of the frame the recorder's grey.
    const frame = new Uint8Array(width * height * 3);
    for (let at = 0; at < frame.length; at += 3) {
      frame[at] = 127;
      frame[at + 1] = 125;
      frame[at + 2] = 129;
    }
    const page = fullFrame();
    for (let y = 0; y < height / 2; y++) {
      const from = y * width * 3;
      frame.set(page.subarray(from, from + (width / 2) * 3), from);
    }
    const report = checkLayout(frame, width, height);
    expect(report.problems.length).toBeGreaterThanOrEqual(2);
    expect(report.problems.join('\n')).toMatch(/top-right quadrant is uniform/);
    expect(report.problems.join('\n')).toMatch(/padding grey covers/);
    expect(report.paddingShare).toBeGreaterThan(0.6);
  });

  it('fails a frame that is a single colour', () => {
    const report = checkLayout(
      new Uint8Array(width * height * 3),
      width,
      height,
    );
    expect(report.problems.length).toBe(4);
  });
});
