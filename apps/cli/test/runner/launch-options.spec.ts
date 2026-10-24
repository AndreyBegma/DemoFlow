import { RENDER_FORMATS } from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  checkRunOptions,
  RUN_OPTIONS,
} from '../../src/runner/launch/options.ts';

describe('checkRunOptions', () => {
  it('announces formats and nothing else', () => {
    expect([...RUN_OPTIONS]).toEqual(['formats']);
  });

  it('keeps the project formats when there are no options', () => {
    expect(checkRunOptions(undefined)).toEqual({ ok: true, formats: null });
  });

  it('returns the formats in order, as the enum constants', () => {
    const result = checkRunOptions({ formats: ['gif', 'mp4-vertical'] });
    expect(result).toEqual({ ok: true, formats: ['gif', 'mp4-vertical'] });
    if (!result.ok || result.formats === null) throw new Error('not ok');
    for (const format of result.formats) {
      expect(RENDER_FORMATS.some((known) => Object.is(known, format))).toBe(
        true,
      );
    }
  });

  it('accepts every format at once', () => {
    expect(checkRunOptions({ formats: [...RENDER_FORMATS] })).toEqual({
      ok: true,
      formats: [...RENDER_FORMATS],
    });
  });

  it.each([
    ['null', null],
    ['an empty array', []],
    ['a string', 'mp4'],
    ['a number', 1],
    ['no formats', {}],
    ['empty formats', { formats: [] }],
    ['formats that is a string', { formats: 'mp4' }],
    ['a repeated format', { formats: ['mp4', 'mp4'] }],
    ['an unknown format', { formats: ['mov'] }],
    ['a non-string format', { formats: [1] }],
    ['ten formats', { formats: [...RENDER_FORMATS, 'mp4'] }],
    ['an extra headed key', { formats: ['mp4'], headed: true }],
    ['an extra baseUrl key', { formats: ['mp4'], baseUrl: 'https://x' }],
    ['headed alone', { headed: true }],
  ])('refuses %s', (_why, value) => {
    expect(checkRunOptions(value)).toEqual({ ok: false });
  });
});
