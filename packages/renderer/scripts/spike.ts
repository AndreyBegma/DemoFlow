import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildRenderPlan,
  ffmpegRenderer,
  frameCount,
  type Renderer,
  remotionRenderer,
} from '../src/index.ts';

/**
 * The renderer spike (spec 4): draws one render plan per run with both
 * renderers, one after the other so they never share the CPU, and reports
 * render time and MP4 size.
 *
 *   spike <runDir>...                  render existing runs
 *   spike --record <parentDir>         record the four fixture runs first
 *   --passes <n>                       render every run n times (default 1)
 *   --copy-to <dir>                    copy each MP4 to <dir>/<run>-<renderer>.mp4
 *
 * Remotion bundles its composition once per process, so its first render here
 * includes the bundle; that one is reported as `cold`.
 */

const USAGE =
  'usage: spike [--record <parentDir>] [--passes <n>] [--copy-to <dir>] [<runDir>...]';

const SCENARIOS = ['customers', 'login', 'tour', 'failing'] as const;

const RENDERERS: readonly Renderer[] = [ffmpegRenderer, remotionRenderer];

interface Measurement {
  run: string;
  renderer: string;
  pass: number;
  cold: boolean;
  frames: number;
  videoSeconds: number;
  renderSeconds: number;
  bytes: number;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      record: { type: 'string' },
      passes: { type: 'string', default: '1' },
      'copy-to': { type: 'string' },
    },
  });
  const passes = Number(values.passes);
  if (!Number.isInteger(passes) || passes < 1) throw new Error(USAGE);

  const runDirs = positionals.map((dir) => path.resolve(dir));
  if (values.record !== undefined) {
    runDirs.push(...(await recordFixtures(path.resolve(values.record))));
  }
  if (runDirs.length === 0) throw new Error(USAGE);

  console.log(
    `node ${process.version} · ${os.platform()} ${os.arch()} · ${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.availableParallelism()} threads)`,
  );

  const measurements: Measurement[] = [];
  const plans = new Map(
    await Promise.all(
      runDirs.map(async (dir) => [dir, await buildRenderPlan(dir)] as const),
    ),
  );
  for (let pass = 1; pass <= passes; pass++) {
    for (const runDir of runDirs) {
      const plan = plans.get(runDir)!;
      for (const renderer of RENDERERS) {
        const cold = !measurements.some((m) => m.renderer === renderer.name);
        const started = performance.now();
        const output = await renderer.render(runDir, plan);
        const renderSeconds = (performance.now() - started) / 1000;
        const file = path.resolve(runDir, output.file);
        measurements.push({
          run: path.basename(runDir),
          renderer: renderer.name,
          pass,
          cold,
          frames: frameCount(plan),
          videoSeconds: plan.durationMs / 1000,
          renderSeconds,
          bytes: (await stat(file)).size,
        });
        if (values['copy-to'] !== undefined) {
          const target = path.resolve(values['copy-to']);
          await mkdir(target, { recursive: true });
          await copyFile(
            file,
            path.join(target, `${path.basename(runDir)}-${renderer.name}.mp4`),
          );
        }
      }
    }
  }

  for (const runDir of runDirs) {
    const run = path.basename(runDir);
    await writeFile(
      path.join(runDir, 'render', 'spike.json'),
      `${JSON.stringify(
        measurements.filter((m) => m.run === run),
        null,
        2,
      )}\n`,
    );
  }
  console.table(
    measurements.map((m) => ({
      run: m.run,
      renderer: m.renderer,
      pass: m.pass,
      cold: m.cold,
      frames: m.frames,
      'video s': m.videoSeconds.toFixed(2),
      'render s': m.renderSeconds.toFixed(2),
      'frames/s': (m.frames / m.renderSeconds).toFixed(1),
      bytes: m.bytes,
    })),
  );
}

/**
 * Records the fixture scenarios through the engine, as the renderer tests do.
 * The helper is test code: it serves `apps/fixture` on an ephemeral port.
 */
async function recordFixtures(parentDir: string): Promise<string[]> {
  const { recordFixtureRun } = await import('../test/plan/fixture-runs.ts');
  const runDirs: string[] = [];
  for (const scenario of SCENARIOS) {
    console.log(`recording ${scenario}…`);
    runDirs.push(await recordFixtureRun(scenario, parentDir));
  }
  return runDirs;
}

main().then(
  // Remotion's browser and the local servers can keep the event loop alive.
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
