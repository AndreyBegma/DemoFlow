import { readFileSync } from 'node:fs';
import { type Issue, parseScenario, type Scenario } from '@demoflow/core';
import { CommandError } from './errors.ts';

/** Reads and validates a scenario file; any problem is a `CommandError` (exit 2). */
export function loadScenario(file: string): {
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
  const parsed = parseScenario(raw);
  if (!parsed.ok) {
    throw new CommandError(
      'invalid-scenario',
      `${file} is not a valid scenario`,
      parsed.errors,
    );
  }
  return { scenario: parsed.value, warnings: parsed.warnings };
}
