import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RenderFormat, RunResult } from '@demoflow/core';
import { readCredentials } from '../auth/credentials.ts';
import { apiBase } from '../auth/server.ts';
import { type HostEnvironment, pathFor } from '../config/platform.ts';
import { packageVersion } from '../version.ts';

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
}): RunReport {
  const { root, result, cliVersion, pathApi = path } = input;
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
  };
  if (result.status === 'failed' && failedStep !== undefined) {
    report.failedStep = failedStep;
  }
  return report;
}

/**
 * The project key is `(runnerId, rootPath)`, so one folder must have one path:
 * symlinks and junctions are resolved (`/tmp` → `/private/tmp` on macOS). A
 * root that cannot be resolved is sent as an absolute path.
 */
export async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * Decision 3: after a run on a paired machine, tell the server it happened.
 * Never throws, never prints, and is over within the timeout: the run's own
 * output and exit code are untouched.
 */
export async function reportRun(
  input: { root: string; result: RunResult },
  deps: ReportDeps,
): Promise<void> {
  try {
    if (isReportOff(deps.host.env)) return;
    const credentials = readCredentials(deps.host);
    if (credentials === null) return;
    const body = buildReport({
      root: await canonicalRoot(input.root),
      result: input.result,
      cliVersion: deps.version(),
      pathApi: pathFor(deps.host.platform),
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
    // Drain so the connection is released; the answer is not used.
    await response.body?.cancel();
  } catch {
    // Decision 3: every failure is silent.
  }
}
