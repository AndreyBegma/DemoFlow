import type { ScheduleConfig } from '@demoflow/core';
import { loadProjectConfig } from '../../config/project.ts';
import { knownRootsSync } from '../../runs-report/reported-runs.ts';
import type { RunnerPaths } from '../paths.ts';
import { readLocalRoots } from './local-roots.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** Decision 4: the reported registry and the roots `demoflow run` ran in. */
export function watchedRoots(paths: RunnerPaths): {
  reported: Set<string>;
  local: string[];
} {
  return {
    reported: knownRootsSync(paths.reportedRuns),
    local: readLocalRoots(paths.localRoots),
  };
}

/** The root's committed `schedule`; throws when its config does not load. */
export function scheduleLoader(
  env: Env,
): (root: string) => ScheduleConfig | undefined {
  return (root) => loadProjectConfig(root, env).schedule;
}

/**
 * Decision 5: true when a watched root's config asks for a schedule, so a
 * daemon without an account has something to do. A config that does not
 * load asks for nothing.
 */
export function hasScheduledRoot(paths: RunnerPaths, env: Env): boolean {
  const { reported, local } = watchedRoots(paths);
  const load = scheduleLoader(env);
  for (const root of new Set([...reported, ...local])) {
    try {
      if (load(root) !== undefined) return true;
    } catch {
      // Skipped, as the scheduler skips it.
    }
  }
  return false;
}

/** The machine's IANA zone name. */
export function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
