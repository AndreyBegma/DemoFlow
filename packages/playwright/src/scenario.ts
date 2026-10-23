import {
  type Issue,
  parseScenario,
  type ScenarioInput,
  type StepInput,
  type Viewport,
} from '@demoflow/core';

// What a recorded scenario holds (spec 208, Decision 7). No timestamps and no
// `baseUrl`: recording twice gives the same bytes, and the project's
// `demoflow.config.json` decides where the replay runs.

export interface RecordedScenario {
  /** `titlePath` after the file. */
  titles: readonly string[];
  /** The test file relative to the config directory, `/`-separated. */
  file: string;
  viewport: Viewport | null;
  steps: readonly StepInput[];
}

export function toScenario(recorded: RecordedScenario): ScenarioInput {
  return {
    schemaVersion: 1,
    name: recorded.titles.join(' › '),
    description: `Recorded from ${recorded.file} by demoflow/playwright.`,
    ...(recorded.viewport === null ? {} : { viewport: recorded.viewport }),
    steps: [...recorded.steps],
  };
}

/** The file's bytes, or the issues `parseScenario` found. */
export function serializeScenario(
  scenario: ScenarioInput,
): { ok: true; text: string } | { ok: false; errors: Issue[] } {
  const parsed = parseScenario(scenario);
  if (!parsed.ok) return parsed;
  return { ok: true, text: `${JSON.stringify(scenario, null, 2)}\n` };
}
