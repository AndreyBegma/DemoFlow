import {
  parseScenario,
  type Scenario,
  type ScenarioInput,
  type ScenarioStepInput,
} from '@demoflow/core';

/**
 * An inline scenario, validated and with defaults applied. It does not dwell
 * or hold the end unless `pacing` says so (C-203), to keep the suite fast.
 */
export function scenario(
  steps: ScenarioStepInput[],
  extra: {
    baseUrl?: string;
    viewport?: { width: number; height: number };
    data?: ScenarioInput['data'];
    setup?: ScenarioInput['setup'];
    pacing?: ScenarioInput['pacing'];
  } = {},
): Scenario {
  const parsed = parseScenario({
    schemaVersion: 1,
    name: 'inline',
    viewport: { width: 1280, height: 720 },
    pacing: { stepDwellMs: 0, endHoldMs: 0 },
    ...extra,
    steps,
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.errors));
  }
  return parsed.value;
}
