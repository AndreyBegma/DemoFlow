import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type RenderFormat,
  type RunResult,
  STAGE_NAMES,
  type StageName,
  type StageStatus,
} from '@demoflow/core';
import { readCredentials } from '../auth/credentials.ts';
import { apiBase } from '../auth/server.ts';
import { type HostEnvironment, pathFor } from '../config/platform.ts';
import { runnerPaths } from '../runner/paths.ts';
import { packageVersion } from '../version.ts';
import { redactMessage } from './redact.ts';
import { appendReportedRun } from './reported-runs.ts';

export const REPORT_TIMEOUT_MS = 2_000;

/**
 * What `POST /runner/runs` takes (`RunReportDto` in the API). Nothing else is
 * ever sent: step values can hold secrets (spec 178, Decision 1).
 */
export interface RunReport {
  rootPath: string;
  projectName: string;
  scenarioName: string;
  scenarioPath: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  formats: RenderFormat[];
  failedStep?: number;
  cliVersion: string;
  /** Spec 264, Decision 1: each stage's status, nothing else from it. */
  stages: Record<StageName, StageStatus>;
  /** Decision 2: one per format; no `file` (a local path), renderer or fps. */
  renders: ReportedRender[];
  /** Decision 3: a failed run's first failed stage, its message redacted. */
  failure?: { stage: StageName; message: string };
}

export interface ReportedRender {
  format: RenderFormat;
  width: number;
  height: number;
  sizeBytes: number;
  durationMs: number;
}

/** Everything the report touches, injected so tests never reach the network. */
export interface ReportDeps {
  host: HostEnvironment;
  fetch: typeof fetch;
  version(): string;
  timeoutMs?: number;
}

export function defaultReportDeps(host: HostEnvironment): ReportDeps {
  return { host, fetch: globalThis.fetch, version: () => packageVersion() };
}

/** Decision 3: off under `CI` and with `DEMOFLOW_NO_REPORT=1`. */
export function isReportOff(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.DEMOFLOW_NO_REPORT === '1') return true;
  return env.CI !== undefined && env.CI !== '';
}

/**
 * The run's metadata. The project is named by its folder: the config has no
 * name of its own.
 */
export function buildReport(input: {
  root: string;
  result: RunResult;
  cliVersion: string;
  pathApi?: path.PlatformPath;
  home?: string;
}): RunReport {
  const { root, result, cliVersion, pathApi = path, home = homedir() } = input;
  const failedStep = Object.values(result.stages)
    .map((stage) => stage.error?.stepIndex)
    .find((index) => index !== undefined);
  const report: RunReport = {
    rootPath: root,
    projectName: pathApi.basename(root) || root,
    scenarioName: result.scenarioName,
    scenarioPath: result.scenarioId,
    status: result.status === 'failed' ? 'failed' : 'passed',
    startedAt: result.startedAt,
    durationMs: Math.max(
      0,
      Math.round(Date.parse(result.finishedAt) - Date.parse(result.startedAt)),
    ),
    formats: [...new Set(result.renders.map((render) => render.format))],
    cliVersion,
    stages: Object.fromEntries(
      STAGE_NAMES.map((name) => [name, result.stages[name].status]),
    ) as Record<StageName, StageStatus>,
    renders: reportedRenders(result),
  };
  if (result.status === 'failed' && failedStep !== undefined) {
    report.failedStep = failedStep;
  }
  if (result.status === 'failed') {
    const failure = failureOf(result, { root, home, pathApi });
    if (failure !== undefined) report.failure = failure;
  }
  return report;
}

/** Decision 2: the first render of each format, in `result.renders` order. */
function reportedRenders(result: RunResult): ReportedRender[] {
  const seen = new Set<RenderFormat>();
  const renders: ReportedRender[] = [];
  for (const render of result.renders) {
    if (seen.has(render.format)) continue;
    seen.add(render.format);
    renders.push({
      format: render.format,
      width: render.width,
      height: render.height,
      sizeBytes: render.sizeBytes,
      durationMs: Math.round(render.durationMs),
    });
  }
  return renders;
}

/**
 * Decision 3: the first failed stage in pipeline order is the cause; later
 * stages fail because of it. Left out when its message redacts to nothing.
 */
function failureOf(
  result: RunResult,
  paths: { root: string; home: string; pathApi: path.PlatformPath },
): RunReport['failure'] {
  for (const stage of STAGE_NAMES) {
    const { status, error } = result.stages[stage];
    if (status !== 'failed' || error?.message === undefined) continue;
    const message = redactMessage(error.message, paths);
    return message === '' ? undefined : { stage, message };
  }
  return undefined;
}

/**
 * The project key is `(runnerId, rootPath)`, so one folder must have one path:
 * symlinks and junctions are resolved (`/tmp` → `/private/tmp` on macOS). A
 * root that cannot be resolved is sent as an absolute path.
 */
export async function canonicalRoot(root: string): Promise<string> {
  try {
    // `.native` also expands Windows 8.3 short names (RUNNER~1).
    return realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

/** The server's run id in a `POST /runner/runs` answer, or `null`. */
function runIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { runId } = body as Record<string, unknown>;
  return typeof runId === 'string' && runId !== '' ? runId : null;
}

/** The project id in a `POST /runner/runs` answer, or `undefined`. */
function projectIdOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { projectId } = body as Record<string, unknown>;
  return typeof projectId === 'string' && projectId !== ''
    ? projectId
    : undefined;
}

/**
 * Decision 3: after a run on a paired machine, tell the server it happened.
 * Never throws, never prints, and is over within the timeout: the run's own
 * output and exit code are untouched. A report the server took is recorded in
 * `reported-runs.jsonl`, so the daemon can stream its video (spec 192).
 */
export async function reportRun(
  input: { root: string; runDir: string; result: RunResult },
  deps: ReportDeps,
): Promise<void> {
  try {
    if (isReportOff(deps.host.env)) return;
    const credentials = readCredentials(deps.host);
    if (credentials === null) return;
    const root = await canonicalRoot(input.root);
    const body = buildReport({
      root,
      result: input.result,
      cliVersion: deps.version(),
      pathApi: pathFor(deps.host.platform),
      home: deps.host.homedir,
    });
    const response = await deps.fetch(
      `${apiBase(credentials.server)}/runner/runs`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${credentials.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deps.timeoutMs ?? REPORT_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      // Drain so the connection is released.
      await response.body?.cancel();
      return;
    }
    // The 2 s signal above still bounds this read (spec 192, Decision 1).
    const answer: unknown = await response.json();
    const runId = runIdOf(answer);
    if (runId === null) return;
    const projectId = projectIdOf(answer);
    appendReportedRun(runnerPaths(deps.host).reportedRuns, {
      id: runId,
      runDir: path.resolve(input.runDir),
      at: new Date().toISOString(),
      // Spec 225: kept so the MCP tools can link the run's page.
      ...(projectId === undefined ? {} : { projectId }),
      server: credentials.server,
      // Spec 248, Decision 1: the root the server knows is the registry key.
      root,
    });
  } catch {
    // Decision 3: every failure is silent.
  }
}
