import { cookies } from 'next/headers';
import {
  listProjectRuns,
  listProjects,
  listRunners,
  type Project,
  type ProjectRunsPage,
  type Runner,
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

/** The first page of a project's runs: the page, `'not_found'` or `'error'`. */
export async function getFirstRuns(
  id: string,
): Promise<ProjectRunsPage | 'not_found' | 'error'> {
  const result = await listProjectRuns(id, undefined, await target());
  if (result.ok) return result.data;
  return result.status === 404 ? 'not_found' : 'error';
}
