import { cookies } from 'next/headers';
import {
  getHealth,
  getRun,
  getSchedule,
  listProjectRuns,
  listProjects,
  listRunners,
  listStale,
  type Project,
  type ProjectRunsPage,
  type ProjectSchedules,
  type RunDetail,
  type Runner,
  type RunStatusFilter,
  type ScenarioHealth,
  type StaleScenario,
} from '@/lib/api';

async function target() {
  return {
    baseUrl: process.env.API_URL ?? 'http://localhost:8370',
    cookie: (await cookies()).toString(),
  };
}

/** The signed-in user's projects, or null when the API fails. */
export async function getProjects(): Promise<Project[] | null> {
  const result = await listProjects(await target());
  return result.ok ? result.data.projects : null;
}

/** The paired machines a project can be bound to; empty when the API fails. */
export async function getMachines(): Promise<Runner[]> {
  const result = await listRunners(await target());
  return result.ok ? result.data.runners : [];
}

/** One run with its project and machine: the detail, `'not_found'` or `'error'`. */
export async function getRunDetail(
  id: string,
): Promise<RunDetail | 'not_found' | 'error'> {
  const result = await getRun(id, await target());
  if (result.ok) return result.data;
  return result.status === 404 ? 'not_found' : 'error';
}

/** The first page of a project's runs: the page, `'not_found'` or `'error'`. */
export async function getFirstRuns(
  id: string,
  status?: RunStatusFilter,
): Promise<ProjectRunsPage | 'not_found' | 'error'> {
  const result = await listProjectRuns(id, undefined, await target(), status);
  if (result.ok) return result.data;
  return result.status === 404 ? 'not_found' : 'error';
}

/** A project's check schedules (spec #363), or null when the API fails. */
export async function getProjectSchedules(
  id: string,
): Promise<ProjectSchedules | null> {
  const result = await getSchedule(id, await target());
  return result.ok ? result.data : null;
}

/** The per-scenario state of a project; empty when the API fails. */
export async function getProjectHealth(id: string): Promise<ScenarioHealth[]> {
  const result = await getHealth(id, await target());
  return result.ok ? result.data : [];
}

/** The user's stale scenarios across projects, or null when the API fails. */
export async function getStale(): Promise<StaleScenario[] | null> {
  const result = await listStale(await target());
  return result.ok ? result.data : null;
}
