import { parseScenario, type Scenario } from '@demoflow/core';
import type { RunStartedEvent, StepStartedEvent } from '@demoflow/engine';
import { describe, expect, it } from 'vitest';
import type { Io } from '../../src/commands/io.ts';
import {
  emitProgress,
  formatProgress,
  progressObserver,
} from '../../src/commands/progress.ts';
import { parseProgressLine } from '../../src/runner/launch/progress.ts';

function capture(): Io & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    stdout: (text) => {
      out.push(text);
    },
    stderr: () => {},
  };
}

function parse(input: unknown): Scenario {
  const result = parseScenario(input);
  if (!result.ok) throw new Error('the test scenario is invalid');
  return result.value;
}

/** One plain step and a `repeat` of one step over two items: three steps. */
const scenario = parse({
  schemaVersion: 1,
  name: 'Repeat',
  data: { items: [{ id: 'a' }, { id: 'b' }] },
  steps: [
    { action: 'navigate', path: '/' },
    {
      action: 'repeat',
      each: 'items',
      as: 'item',
      steps: [{ action: 'navigate', path: '/{{item.id}}' }],
    },
  ],
});

const started = (s: Scenario) => ({ scenario: s }) as RunStartedEvent;
const step = (stepIndex: number) => ({ stepIndex }) as StepStartedEvent;

describe('progressObserver', () => {
  it('prints a steps line per started step with the expanded total', async () => {
    const io = capture();
    const observer = progressObserver(io);
    await observer.onRunStarted?.(started(scenario));
    for (const i of [0, 1, 2]) await observer.onStepStarted?.(step(i));
    expect(io.out.map((l) => parseProgressLine(l.trim()))).toEqual([
      { phase: 'steps', step: 1, steps: 3 },
      { phase: 'steps', step: 2, steps: 3 },
      { phase: 'steps', step: 3, steps: 3 },
    ]);
  });

  it('does not throw when stdout does, or when the scenario cannot expand', async () => {
    const broken: Io = {
      stdout: () => {
        throw new Error('EPIPE');
      },
      stderr: () => {},
    };
    const observer = progressObserver(broken);
    await observer.onRunStarted?.(started(scenario));
    expect(() => observer.onStepStarted?.(step(0))).not.toThrow();
    expect(() => emitProgress(broken, { phase: 'app' })).not.toThrow();

    const io = capture();
    const bad = progressObserver(io);
    await bad.onRunStarted?.(started({} as Scenario));
    await bad.onStepStarted?.(step(0));
    expect(io.out).toEqual([]);
  });
});

describe('parseProgressLine', () => {
  it('accepts the three shapes the run prints', () => {
    for (const progress of [
      { phase: 'app' },
      { phase: 'steps', step: 3, steps: 7 },
      { phase: 'rendering' },
    ] as const) {
      expect(parseProgressLine(formatProgress(progress).trim())).toEqual(
        progress,
      );
    }
  });

  it.each([
    ['non-JSON', 'starting'],
    ['an array', '[]'],
    ['the --json result', '{"runId":"r","status":"completed","stages":{}}'],
    ['a wrong type', '{"type":"result","phase":"app"}'],
    ['an unknown phase', '{"type":"progress","phase":"x"}'],
    ['step 0', '{"type":"progress","phase":"steps","step":0,"steps":2}'],
    ['step > steps', '{"type":"progress","phase":"steps","step":3,"steps":2}'],
    [
      'steps 10001',
      '{"type":"progress","phase":"steps","step":1,"steps":10001}',
    ],
    ['a fraction', '{"type":"progress","phase":"steps","step":1.5,"steps":2}'],
    ['numbers on app', '{"type":"progress","phase":"app","step":1,"steps":2}'],
  ])('rejects %s', (_name, text) => {
    expect(parseProgressLine(text)).toBeNull();
  });
});
