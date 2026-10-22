import type { ScenarioStep } from '@demoflow/core';

// Coverage against a hand-written scenario (spike #202's measure): how many of
// its steps the recording reproduces, in order, by longest common
// subsequence. Presentation fields are not compared, because a test has none.

const PRESENTATION = new Set(['caption', 'zoom', 'timeoutMs', 'match']);

function key(step: ScenarioStep): string {
  const fields = Object.entries(step)
    .filter(([name, value]) => !PRESENTATION.has(name) && value !== undefined)
    .map(([name, value]) => [name, normalise(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(fields);
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  // `exact: false` and no `exact` mean the same locator.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, inner]) => !(name === 'exact' && inner === false))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, inner]) => [name, normalise(inner)]),
  );
}

export interface Coverage {
  expected: number;
  matched: number;
  missing: ScenarioStep[];
  extra: ScenarioStep[];
}

export function coverage(
  expected: readonly ScenarioStep[],
  actual: readonly ScenarioStep[],
): Coverage {
  const a = expected.map(key);
  const b = actual.map(key);
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const missing: ScenarioStep[] = [];
  const extra: ScenarioStep[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      missing.push(expected[i++]!);
    } else {
      extra.push(actual[j++]!);
    }
  }
  missing.push(...expected.slice(i));
  extra.push(...actual.slice(j));
  return { expected: expected.length, matched: table[0]![0]!, missing, extra };
}
