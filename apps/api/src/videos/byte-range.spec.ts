import { parseRange, spanOf } from './byte-range';

describe('parseRange', () => {
  it.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=100-', { start: 100 }],
    ['bytes=-500', { suffix: 500 }],
    ['bytes= 5 - 9 ', { start: 5, end: 9 }],
  ])('reads %s', (header, range) => {
    expect(parseRange(header)).toEqual(range);
  });

  it.each([
    ['no header', undefined],
    ['a multi-range', 'bytes=0-1,4-5'],
    ['another unit', 'items=0-1'],
    ['an empty spec', 'bytes=-'],
    ['a backwards range', 'bytes=9-5'],
    ['garbage', 'bytes=abc'],
    ['a number past 2^53', `bytes=0-${'9'.repeat(20)}`],
  ])('treats %s as no range', (_label, header) => {
    expect(parseRange(header)).toBeNull();
  });
});

describe('spanOf', () => {
  it('is the whole file without a range', () => {
    expect(spanOf(null, 10)).toEqual({ start: 0, end: 9 });
  });

  it('clamps the end to the file', () => {
    expect(spanOf({ start: 2, end: 50 }, 10)).toEqual({ start: 2, end: 9 });
    expect(spanOf({ start: 2 }, 10)).toEqual({ start: 2, end: 9 });
  });

  it('takes a suffix from the end, the whole file when it is longer', () => {
    expect(spanOf({ suffix: 3 }, 10)).toEqual({ start: 7, end: 9 });
    expect(spanOf({ suffix: 30 }, 10)).toEqual({ start: 0, end: 9 });
  });

  it('is null when nothing is satisfiable', () => {
    expect(spanOf({ start: 10 }, 10)).toBeNull();
    expect(spanOf({ suffix: 0 }, 10)).toBeNull();
    expect(spanOf(null, 0)).toBeNull();
  });
});
