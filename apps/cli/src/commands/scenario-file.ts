import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type FragmentSource,
  type Issue,
  parseScenario,
  type Scenario,
} from '@demoflow/core';
import { fragmentsNear } from '../config/index.ts';
import { CommandError } from './errors.ts';

/**
 * Reads and validates a scenario file; any problem is a `CommandError` (exit 2).
 * Its includes are resolved from `fragments`, by default those of the project
 * holding the file (ADR-0018).
 */
export function loadScenario(
  file: string,
  fragments: FragmentSource = fragmentsNear(file),
): {
  scenario: Scenario;
  warnings: Issue[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      'scenario-unreadable',
      `cannot read ${file}: ${reason}`,
    );
  }
  const parsed = parseScenario(raw, { fragments });
  if (!parsed.ok) {
    throw new CommandError(
      'invalid-scenario',
      `${file} is not a valid scenario`,
      parsed.errors,
    );
  }
  return { scenario: parsed.value, warnings: parsed.warnings };
}

/**
 * The scenario's `description`, read from the project when its file is still
 * there and loads (spec 255, Decision 3): the intro card's subtitle and a
 * share's description (spec 349). An inline scenario of `demoflow mcp` is
 * gone after its run, so it has none.
 */
export function scenarioDescription(
  root: string,
  scenarioId: string,
): string | undefined {
  const file = path.join(root, scenarioId);
  if (!existsSync(file)) return undefined;
  try {
    return loadScenario(file).scenario.description;
  } catch {
    return undefined;
  }
}
