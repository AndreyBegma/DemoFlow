import { describe, expect, it } from 'vitest';
import type { Progress } from '../../src/commands/progress.ts';
import { ProgressGate } from '../../src/runner/launch/progress.ts';
import { FakeClock } from './fakes.ts';

const at = (step: number): Progress => ({ phase: 'steps', step, steps: 9 });

function gate() {
  const clock = new FakeClock();
  const sent: Progress[] = [];
  return {
    clock,
    sent,
    gate: new ProgressGate(clock, (p) => sent.push(p)),
  };
}

describe('ProgressGate', () => {
  it('sends the first progress at once', () => {
    const { gate: g, sent } = gate();
    g.push({ phase: 'app' });
    expect(sent).toEqual([{ phase: 'app' }]);
  });

  it('sends the last of three within a second when the second is up', async () => {
    const { gate: g, sent, clock } = gate();
    g.push({ phase: 'app' });
    g.push(at(1));
    g.push(at(2));
    g.push(at(3));
    await clock.advance(1_000);
    expect(sent).toEqual([{ phase: 'app' }, at(3)]);
  });

  it('does not send a repeat of the last one sent', async () => {
    const { gate: g, sent, clock } = gate();
    g.push(at(1));
    await clock.advance(2_000);
    g.push(at(1));
    await clock.advance(2_000);
    expect(sent).toEqual([at(1)]);
  });

  it('drops a waiting progress when the last sent comes back', async () => {
    const { gate: g, sent, clock } = gate();
    g.push(at(1));
    g.push(at(2));
    g.push(at(1));
    await clock.advance(2_000);
    expect(sent).toEqual([at(1)]);
  });

  it('sends at once when a second has passed since the last frame', async () => {
    const { gate: g, sent, clock } = gate();
    g.push(at(1));
    await clock.advance(1_500);
    g.push(at(2));
    expect(sent).toEqual([at(1), at(2)]);
  });

  it('sends nothing after stop', async () => {
    const { gate: g, sent, clock } = gate();
    g.push(at(1));
    g.push(at(2));
    g.stop();
    await clock.advance(5_000);
    g.push(at(3));
    expect(sent).toEqual([at(1)]);
  });
});
