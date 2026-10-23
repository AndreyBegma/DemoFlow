import { describe, expect, it } from 'vitest';
import { markerProblem, PASS_THROUGH } from '../../src/helpers.ts';

describe('markerProblem', () => {
  it('takes a caption of 1–120 characters', () => {
    expect(markerProblem('caption', 'Slow report')).toBe(undefined);
    expect(markerProblem('caption', 'c'.repeat(120))).toBe(undefined);
  });

  it('refuses an empty caption, or one over 120 characters', () => {
    expect(markerProblem('caption', '')).toBe('expected 1–120 characters');
    expect(markerProblem('caption', 'c'.repeat(121))).toBe(
      'expected 1–120 characters',
    );
  });

  it('refuses only an empty scene title', () => {
    expect(markerProblem('scene', 'Checkout')).toBe(undefined);
    expect(markerProblem('scene', 's'.repeat(200))).toBe(undefined);
    expect(markerProblem('scene', '')).toBe('expected a title');
  });
});

describe('PASS_THROUGH', () => {
  it('does nothing and never throws', () => {
    expect(PASS_THROUGH.caption('')).toBe(undefined);
    expect(PASS_THROUGH.caption('c'.repeat(121))).toBe(undefined);
    expect(PASS_THROUGH.scene('')).toBe(undefined);
  });
});
