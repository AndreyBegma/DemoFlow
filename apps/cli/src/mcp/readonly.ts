import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveFfmpeg } from '@demoflow/renderer';
import { readResult } from '../commands/settle.ts';
import { type HostEnvironment, runDir as runDirFor } from '../config/index.ts';
import { ToolError } from './errors.ts';
import {
  checkInlineScenario,
  resolveProject,
  resolveScenarioFile,
} from './project.ts';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** The directory of a project that holds its scenarios. */
const SCENARIO_DIR = 'demoflow';

export interface ValidateInput {
  project?: string;
  scenario?: unknown;
  file?: string;
}

/** Checks a scenario without running it: nothing is spawned or written. */
export function validateScenario(
  input: ValidateInput,
  cwd: string,
  host: HostEnvironment,
): { valid: true } {
  const inline = input.scenario !== undefined;
  if (inline === (input.file !== undefined)) {
    throw new ToolError(
      'both-or-neither-scenario',
      inline
        ? 'both `scenario` and `file` were given'
        : 'neither `scenario` nor `file` was given',
      'Pass exactly one: an inline `scenario` object, or the `file` of a *.demo.json in the project.',
    );
  }
  if (input.file !== undefined) {
    const project = resolveProject(input.project, cwd, host);
    resolveScenarioFile(project.root, input.file);
  } else {
    checkInlineScenario(input.scenario);
  }
  return { valid: true };
}

export interface DemoSummary {
  taskId: string;
  scenarioName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  video?: string;
}

/** Recent runs of the project's home, newest first; unreadable ones are skipped. */
export async function listDemos(
  input: { project?: string; limit?: number },
  cwd: string,
  host: HostEnvironment,
): Promise<{ demos: DemoSummary[] }> {
  const project = resolveProject(input.project, cwd, host);
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  const runsDir = path.dirname(runDirFor(project.home, 'x', host.platform));
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return { demos: [] };
  }

  const demos: DemoSummary[] = [];
  for (const name of names) {
    const runDir = runDirFor(project.home, name, host.platform);
    try {
      const result = await readResult(runDir);
      const demo: DemoSummary = {
        taskId: name,
        scenarioName: result.scenarioName,
        status: result.status,
        startedAt: result.startedAt,
      };
      const render = result.renders[0];
      if (render !== undefined) {
        demo.durationMs = render.durationMs;
        const video = path.join(runDir, ...render.file.split('/'));
        if (existsSync(video)) demo.video = video;
      }
      demos.push(demo);
    } catch {
      // No result.json, or one that is not a run result: not a demo.
    }
  }
  demos.sort(
    (a, b) =>
      Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
      (a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : 0),
  );
  return { demos: demos.slice(0, limit) };
}

export interface ProjectCheck {
  root: string;
  configValid: boolean;
  scenarios: string[];
  ffmpeg: 'system' | 'bundled' | 'missing';
  browser: 'installed' | 'missing';
}

/** Whether the project can run demos. A missing or broken config is an error, as for every tool. */
export async function checkProject(
  input: { project?: string },
  cwd: string,
  host: HostEnvironment,
): Promise<ProjectCheck> {
  const project = resolveProject(input.project, cwd, host);
  return {
    root: project.root,
    configValid: true,
    scenarios: await scenarioFiles(project.root),
    ffmpeg: ffmpegAvailability(),
    browser: await browserAvailability(),
  };
}

/** `demoflow/**\/*.demo.json`, relative to the root with `/` separators, sorted. */
async function scenarioFiles(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (
      await readdir(path.join(root, SCENARIO_DIR), { recursive: true })
    ).map(String);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.demo.json'))
    .map((entry) => [SCENARIO_DIR, ...entry.split(path.sep)].join('/'))
    .sort();
}

function ffmpegAvailability(): ProjectCheck['ffmpeg'] {
  try {
    return resolveFfmpeg() === 'ffmpeg' ? 'system' : 'bundled';
  } catch {
    return 'missing';
  }
}

async function browserAvailability(): Promise<ProjectCheck['browser']> {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath()) ? 'installed' : 'missing';
  } catch {
    return 'missing';
  }
}
