import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type RunResult,
  RunResultSchema,
  type Scenario,
  type Timeline,
  TimelineSchema,
} from '@demoflow/core';
import type { EngineObserver, RunOutcome } from '../execute/observer.ts';
import type { RecordingOptions } from '../execute/recording.ts';

/** The files the engine writes into a run directory (spec 3, Decisions). */
export const RUN_FILES = {
  video: 'source.webm',
  timeline: 'timeline.json',
  scenario: 'scenario.json',
  result: 'result.json',
  screenshotsDir: 'screenshots',
} as const;

export interface CaptureOptions {
  /** The scenario's path relative to the project root; written to `result.json`. */
  scenarioId: string;
  /** Defaults to the run directory's name, which the caller names after the run id. */
  runId?: string;
}

/**
 * The observer that persists a run: names the video, stores screenshots and
 * writes `scenario.json`, `timeline.json` and `result.json`. Pass it to
 * `runScenario` in `observers`; use one instance per run.
 */
export function createCaptureObserver(options: CaptureOptions): EngineObserver {
  let runDir = '';
  let scenario: Scenario | undefined;
  let recording: RecordingOptions | undefined;

  return {
    async onRunStarted(event) {
      runDir = event.runDir;
      scenario = event.scenario;
      recording = event.recording;
      await mkdir(runDir, { recursive: true });
      // The scenario as validated: `valueFrom` stays, no secret is resolved.
      await writeJson(path.join(runDir, RUN_FILES.scenario), event.scenario);
    },

    async onScreenshot({ name, png }) {
      const dir = path.join(runDir, RUN_FILES.screenshotsDir);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${name}.png`), png);
      // Run-relative and `/`-separated on every platform: it goes into JSON.
      return `${RUN_FILES.screenshotsDir}/${name}.png`;
    },

    async onRunFinished({ outcome }) {
      if (scenario === undefined || recording === undefined) return;

      // Without a video there is no timeline: the run stopped before the browser.
      if (outcome.videoPath !== undefined) {
        await rename(outcome.videoPath, path.join(runDir, RUN_FILES.video));
        const timeline: Timeline = TimelineSchema.parse({
          schemaVersion: 1,
          viewport: recording.viewport,
          deviceScaleFactor: recording.deviceScaleFactor,
          device: recording.device,
          videoFile: RUN_FILES.video,
          events: outcome.events,
          ...(outcome.syncMark === undefined
            ? {}
            : { syncMark: outcome.syncMark }),
          ...(outcome.navigations === undefined
            ? {}
            : { navigations: outcome.navigations }),
          ...(outcome.maskedElements === undefined
            ? {}
            : { maskedElements: outcome.maskedElements }),
          ...(outcome.annotations === undefined
            ? {}
            : { annotations: outcome.annotations }),
          ...(outcome.endHoldMs === undefined
            ? {}
            : { endHoldMs: outcome.endHoldMs }),
        });
        await writeJson(path.join(runDir, RUN_FILES.timeline), timeline);
      }
      await writeJson(
        path.join(runDir, RUN_FILES.result),
        runResult(outcome, scenario, {
          runId: options.runId ?? path.basename(runDir),
          scenarioId: options.scenarioId,
        }),
      );
    },
  };
}

function runResult(
  outcome: RunOutcome,
  scenario: Scenario,
  ids: { runId: string; scenarioId: string },
): RunResult {
  return RunResultSchema.parse({
    schemaVersion: 1,
    runId: ids.runId,
    scenarioId: ids.scenarioId,
    scenarioName: scenario.name,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    status: outcome.status,
    stages: outcome.stages,
    renders: [],
    warnings: outcome.warnings,
  });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
