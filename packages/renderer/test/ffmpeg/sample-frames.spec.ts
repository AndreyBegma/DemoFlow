import { describe, expect, it } from 'vitest';
import { sampleFrames, selectFrames } from './sample-frames.ts';

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

describe('selectFrames', () => {
  it('folds a run of consecutive frames into one between term (#365)', () => {
    // CI ran out of memory on eq(n,67)+eq(n,68)+…+eq(n,197).
    const run = Array.from({ length: 131 }, (_, i) => 67 + i);
    expect(selectFrames(run)).toBe('between(n\\,67\\,197)');
  });

  it('keeps a lone frame as eq and splits runs at gaps', () => {
    expect(selectFrames([3, 7, 8, 9, 12, 20, 21])).toBe(
      'eq(n\\,3)+between(n\\,7\\,9)+eq(n\\,12)+between(n\\,20\\,21)',
    );
  });

  it('selects exactly the given frames', () => {
    const numbers = [0, 1, 2, 5, 6, 10, 15, 16, 17, 18, 30];
    const terms = selectFrames(numbers)
      .split('+')
      .map((term) => term.match(/\d+/g)?.map(Number) ?? []);
    const selected = Array.from({ length: 40 }, (_, n) => n).filter((n) =>
      terms.some(([a, b = a]) => n >= a && n <= b),
    );
    expect(selected).toEqual(numbers);
  });

  it('is empty for no frames', () => {
    expect(selectFrames([])).toBe('');
  });
});
