import { describe, expect, it } from 'vitest';
import { moveSteps } from '../../src/index.ts';

describe('moveSteps', () => {
  it('is round(distance / 12) between the bounds', () => {
    expect(moveSteps({ x: 0, y: 0 }, { x: 180, y: 240 })).toBe(25);
    expect(moveSteps({ x: 0, y: 0 }, { x: 0, y: 240 })).toBe(20);
    expect(moveSteps({ x: 0, y: 0 }, { x: 0, y: 246 })).toBe(21);
  });

  it('never moves in fewer than 8 steps', () => {
    expect(moveSteps({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(8);
    expect(moveSteps({ x: 0, y: 0 }, { x: 50, y: 0 })).toBe(8);
  });

  it('never moves in more than 40 steps', () => {
    expect(moveSteps({ x: 0, y: 0 }, { x: 1920, y: 1080 })).toBe(40);
  });
});
