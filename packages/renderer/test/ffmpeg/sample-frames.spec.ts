import { describe, expect, it } from 'vitest';
import { sampleFrames } from './sample-frames.ts';

describe('sampleFrames', () => {
  it('does not repeat the last frame when it falls on a step (#44)', () => {
    // Run 39120234521 asked for 27,42,57,72,72 and got four frames back.
    expect(sampleFrames(27, 73, 15)).toEqual([27, 42, 57, 72]);
  });

  it('ends on the frame before `to` when it is off the step', () => {
    expect(sampleFrames(0, 40, 15)).toEqual([0, 15, 30, 39]);
  });

  it('keeps both ends of a range shorter than a step', () => {
    expect(sampleFrames(10, 14, 15)).toEqual([10, 13]);
  });

  it('returns one frame for a one-frame range and none for an empty one', () => {
    expect(sampleFrames(5, 6, 15)).toEqual([5]);
    expect(sampleFrames(5, 5, 15)).toEqual([]);
    expect(sampleFrames(9, 5, 15)).toEqual([]);
  });

  it('is ascending, distinct and within the range for every input', () => {
    for (let from = 0; from < 40; from++) {
      for (let to = from + 1; to < from + 80; to++) {
        const numbers = sampleFrames(from, to, 15);
        expect(numbers[0]).toBe(from);
        expect(numbers.at(-1)).toBe(to - 1);
        for (let i = 1; i < numbers.length; i++) {
          expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
          expect(numbers[i] - numbers[i - 1]).toBeLessThanOrEqual(15);
        }
      }
    }
  });
});
