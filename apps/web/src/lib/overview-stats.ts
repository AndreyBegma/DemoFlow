import type { Project } from './api';

export interface OverviewStats {
  projects: number;
  runs: number;
  /** Projects whose latest run failed. */
  failing: number;
}

/** The Overview's tiles (spec #373, Decision 9), from the project list. */
export function overviewStats(
  projects: readonly Pick<Project, 'runCount' | 'lastRun'>[],
): OverviewStats {
  let runs = 0;
  let failing = 0;
  for (const project of projects) {
    runs += project.runCount;
    if (project.lastRun?.status === 'failed') failing += 1;
  }
  return { projects: projects.length, runs, failing };
}

/** How many of the machines are connected now. */
export function onlineCount(runners: readonly { online: boolean }[]): number {
  return runners.filter((runner) => runner.online).length;
}
