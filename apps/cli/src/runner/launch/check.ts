import { LIST_MAX_SCENARIOS } from './list.ts';
import { isScenarioId } from './scenario-id.ts';

/** Spec 360, Decision 6: the launch cap, per scenario of a check pass. */
export const CHECK_SCENARIO_MAX_MS = 15 * 60_000;
/** Spec 360, Decision 6: a whole check pass is killed after this. */
export const CHECK_PASS_MAX_MS = 2 * 60 * 60_000;

const CHECK_START_FIELDS = new Set([
  'type',
  'requestId',
  'rootPath',
  'exclude',
]);

export type CheckStart =
  | { ok: true; requestId: string; rootPath: string; exclude: string[] }
  | {
      ok: false;
      requestId: string;
      code: 'request-invalid' | 'exclude-invalid';
    }
  | { ok: false; requestId: null };

/**
 * Spec 360, Decision 6: `check.start { requestId, rootPath, exclude }` and
 * nothing else; `exclude` holds at most `LIST_MAX_SCENARIOS` scenario ids.
 * Pure: a refused request touches no file. A request with no string
 * `requestId` cannot be answered and is ignored.
 */
export function checkCheckStart(message: Record<string, unknown>): CheckStart {
  const { requestId, rootPath, exclude } = message;
  if (typeof requestId !== 'string') return { ok: false, requestId: null };
  if (
    typeof rootPath !== 'string' ||
    Object.keys(message).some((key) => !CHECK_START_FIELDS.has(key))
  ) {
    return { ok: false, requestId, code: 'request-invalid' };
  }
  if (
    !Array.isArray(exclude) ||
    exclude.length > LIST_MAX_SCENARIOS ||
    !exclude.every(isScenarioId)
  ) {
    return { ok: false, requestId, code: 'exclude-invalid' };
  }
  return { ok: true, requestId, rootPath, exclude: [...new Set(exclude)] };
}

function parsed(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True for the line `run --check --progress` prints as each scenario starts. */
export function isCheckProgressLine(line: string): boolean {
  const value = parsed(line);
  return value?.type === 'progress' && value.phase === 'check';
}

/** The totals of the pass's final `--json` object, or `null` for any other line. */
export function checkTotals(
  line: string,
): { passed: number; failed: number } | null {
  const value = parsed(line);
  if (value?.check !== true) return null;
  const { passed, failed } = value;
  return isCount(passed) && isCount(failed) ? { passed, failed } : null;
}
