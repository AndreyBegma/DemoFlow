import { describe, expect, it } from 'vitest';
import { pageToClockShift, toSyncMark } from '../../src/execute/sync-mark.ts';

describe('pageToClockShift', () => {
  it('maps the page clock through the midpoint of the round-trip', () => {
    // The page clock runs 1 000 ms ahead; it was read 10 ms into a 20 ms trip.
    expect(
      pageToClockShift([{ sentMs: 100, pageMs: 1_110, receivedMs: 120 }]),
    ).toBe(-1_000);
  });

  // #48: the old `offMs` was read after a round-trip, so a slow one biased it
  // late. Only the fastest exchange is trusted.
  it('keeps the exchange with the shortest round-trip', () => {
    const shift = pageToClockShift([
      // Slow: a 40 ms trip, the page answered early in it.
      { sentMs: 100, pageMs: 1_102, receivedMs: 140 },
      // Fast: a 2 ms trip; the page clock is 1 000 ms ahead.
      { sentMs: 150, pageMs: 1_151, receivedMs: 152 },
      { sentMs: 160, pageMs: 1_175, receivedMs: 190 },
    ]);
    expect(shift).toBe(-1_000);
  });

  it('throws without an exchange, which recordSyncMark turns into no mark', () => {
    expect(() => pageToClockShift([])).toThrow();
  });
});

describe('toSyncMark', () => {
  // Logged on a loaded `bun run test` (#48): the first frame began before
  // clock zero on the engine's clock, and the whole mark used to be dropped.
  const exchanges = [
    { sentMs: 418.812512, pageMs: 446.7000000178814, receivedMs: 420.349837 },
    { sentMs: 420.354837, pageMs: 448.10000002384186, receivedMs: 423.703389 },
    { sentMs: 427.365325, pageMs: 454.90000000596046, receivedMs: 428.791948 },
  ];

  it('keeps a mark whose first frame maps to just before clock zero, from zero', () => {
    const mark = toSyncMark({ onMs: 26.8, offMs: 426.8 }, exchanges);
    expect(mark?.colour).toBe('#ff00ff');
    expect(mark?.onMs).toBe(0);
    // Shift from the fastest exchange (1.43 ms): midpoint 428.08 − 454.9.
    expect(mark?.offMs).toBeCloseTo(426.8 + 428.0786365 - 454.9, 6);
  });

  it('gives no mark when the clear does not come after the paint', () => {
    expect(toSyncMark({ onMs: 30, offMs: 26 }, exchanges)).toBeUndefined();
  });
});
