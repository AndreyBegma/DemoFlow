import { readFileSync } from 'node:fs';
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
