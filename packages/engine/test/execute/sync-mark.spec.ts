import { describe, expect, it } from 'vitest';
import {
  pageToClockShift,
  SYNC_MARK_HOLD_MS,
  toSyncMark,
} from '../../src/execute/sync-mark.ts';

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
    // #64: the clamp used to move `onMs` alone, so the hold shrank by the
    // amount clamped (here 0.02 ms; 5.26 ms on Ubuntu CI).
    expect((mark?.offMs ?? 0) - (mark?.onMs ?? 0)).toBeGreaterThanOrEqual(
      SYNC_MARK_HOLD_MS,
    );
  });

  it('keeps the hold whole however far before zero the first frame maps', () => {
    // Page clock 1 000 ms ahead of the engine's; first frame at page 995.
    const mark = toSyncMark({ onMs: 995, offMs: 1_395 }, [
      { sentMs: 100, pageMs: 1_110, receivedMs: 120 },
    ]);
    expect(mark?.onMs).toBe(0);
    expect((mark?.offMs ?? 0) - (mark?.onMs ?? 0)).toBeGreaterThanOrEqual(
      SYNC_MARK_HOLD_MS,
    );
  });

  it('does not move edges that already map after clock zero', () => {
    const mark = toSyncMark({ onMs: 1_200, offMs: 1_600 }, [
      { sentMs: 100, pageMs: 1_110, receivedMs: 120 },
    ]);
    expect(mark).toMatchObject({ onMs: 200, offMs: 600 });
  });

  it('gives no mark when the clear does not come after the paint', () => {
    expect(toSyncMark({ onMs: 30, offMs: 26 }, exchanges)).toBeUndefined();
  });
});
