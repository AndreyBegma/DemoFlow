import { credentialsPath } from '../auth/credentials.ts';
import { type HostEnvironment, pathFor } from '../config/platform.ts';

/** Everything the daemon keeps on disk, next to `credentials.json` (spec 151, Decision 1). */
export interface RunnerPaths {
  dir: string;
  /** `{ pid, startedAt }` of the one daemon on this machine. */
  lock: string;
  /** Rotated at 5 MB into `runner.log.1` and `runner.log.2`. */
  log: string;
  /** The connection state `status` reports. */
  state: string;
  /** Written by `stop`; the daemon leaves when it sees it. */
  stop: string;
  /** Server run id → run directory, one JSON line per reported run (spec 192). */
  reportedRuns: string;
  /** The folders the website may name (spec 377, Decision 1). */
  allowedRoots: string;
  /** Roots registered from the website, one JSON line each (spec 377, Decision 8). */
  websiteProjects: string;
}

export function runnerPaths(host: HostEnvironment): RunnerPaths {
  const p = pathFor(host.platform);
  const dir = p.dirname(credentialsPath(host));
  return {
    dir,
    lock: p.join(dir, 'runner.lock'),
    log: p.join(dir, 'runner.log'),
    state: p.join(dir, 'runner.state.json'),
    stop: p.join(dir, 'runner.stop'),
    reportedRuns: p.join(dir, 'reported-runs.jsonl'),
    allowedRoots: p.join(dir, 'allowed-roots.json'),
    websiteProjects: p.join(dir, 'website-projects.jsonl'),
  };
}
