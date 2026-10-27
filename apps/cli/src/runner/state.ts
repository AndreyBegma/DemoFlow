import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'revoked'
  /** Spec 361, Decision 5: no account, scheduled checks only. */
  | 'local';

const STATES: readonly ConnectionState[] = [
  'connecting',
  'connected',
  'reconnecting',
  'revoked',
  'local',
];

/** `runner.state.json`: what the daemon tells `status`. Never the token. */
export interface RunnerState {
  pid: number;
  startedAt: string;
  /** Absent in local mode: there is no server (spec 361, Decision 5). */
  server?: string;
  state: ConnectionState;
  /** When the next attempt starts, while `reconnecting`. */
  retryAt?: string;
  /** Refreshed at least every heartbeat; `stop` trusts the PID only while fresh. */
  updatedAt: string;
}

/** Through a temp file and a rename, so `status` never reads half a file. */
export function writeState(file: string, state: RunnerState): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A missing or malformed file is `null`. */
export function readState(file: string): RunnerState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { pid, startedAt, server, state, retryAt, updatedAt } = raw as Record<
    string,
    unknown
  >;
  const known = STATES.find((value) => value === state);
  if (
    typeof pid !== 'number' ||
    typeof startedAt !== 'string' ||
    (server !== undefined && typeof server !== 'string') ||
    typeof updatedAt !== 'string' ||
    known === undefined
  ) {
    return null;
  }
  return {
    pid,
    startedAt,
    ...(typeof server === 'string' ? { server } : {}),
    state: known,
    ...(typeof retryAt === 'string' ? { retryAt } : {}),
    updatedAt,
  };
}
