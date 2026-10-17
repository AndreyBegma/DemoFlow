import { parseScenario, type Scenario, type StepInput } from '@demoflow/core';

/** An inline scenario, validated and with defaults applied. */
export function scenario(
  steps: StepInput[],
  extra: {
    baseUrl?: string;
    viewport?: { width: number; height: number };
  } = {},
): Scenario {
  const parsed = parseScenario({
    schemaVersion: 1,
    name: 'inline',
    viewport: { width: 1280, height: 720 },
    ...extra,
    steps,
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.errors));
  }
  return parsed.value;
}
