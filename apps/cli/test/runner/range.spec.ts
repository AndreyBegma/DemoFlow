import { describe, expect, it } from 'vitest';
import { parseRange, resolveRange } from '../../src/runner/relay/range.ts';

describe('resolveRange', () => {
  it.each([
    ['the whole file', null, 100, { start: 0, end: 99 }],
    ['a-b', { start: 10, end: 19 }, 100, { start: 10, end: 19 }],
    ['a-', { start: 90 }, 100, { start: 90, end: 99 }],
    ['-n', { suffix: 30 }, 100, { start: 70, end: 99 }],
    ['-n past the size', { suffix: 500 }, 100, { start: 0, end: 99 }],
    [
      'an end past the size',
      { start: 50, end: 1_000 },
      100,
      { start: 50, end: 99 },
    ],
    ['the last byte', { start: 99, end: 99 }, 100, { start: 99, end: 99 }],
  ] as const)('%s', (_name, range, size, span) => {
    expect(resolveRange(range, size)).toEqual(span);
  });

  it.each([
    ['a start at the size', { start: 100 }, 100],
    ['a start past the size', { start: 500, end: 600 }, 100],
    ['a zero suffix', { suffix: 0 }, 100],
    ['an end before the start', { start: 20, end: 10 }, 100],
    ['an empty file, whole', null, 0],
    ['an empty file with a range', { start: 0 }, 0],
    ['an empty file with a suffix', { suffix: 5 }, 0],
  ] as const)('%s is unsatisfiable', (_name, range, size) => {
    expect(resolveRange(range, size)).toBe('bad-range');
  });
});

describe('parseRange', () => {
  it.each([
    [null, null],
    [{ start: 0 }, { start: 0 }],
    [
      { start: 1, end: 2 },
      { start: 1, end: 2 },
    ],
    [{ suffix: 9 }, { suffix: 9 }],
  ])('accepts %j', (value, range) => {
    expect(parseRange(value)).toEqual(range);
  });

  it.each([
    undefined,
    'bytes=0-1',
    [],
    {},
    { start: -1 },
    { start: 1.5 },
    { start: '0' },
    { start: 0, end: -1 },
    { suffix: -1 },
    { suffix: 1, start: 0 },
    { start: 0, path: '/etc/passwd' },
  ])('refuses %j', (value) => {
    expect(parseRange(value)).toBeUndefined();
  });
});
