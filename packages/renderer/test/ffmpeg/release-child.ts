// Run by `release.spec.ts` as its own Node process: records the `customers`
// fixture run, renders it, prints `rendered` and returns — no `process.exit`.
// The process ends only when nothing the engine or the renderer opened is left.
import { buildRenderPlan, ffmpegRenderer } from '../../src/index.ts';
import { recordFixtureRun } from '../plan/fixture-runs.ts';

const parentDir = process.argv[2];
if (parentDir === undefined) throw new Error('usage: release-child.ts <dir>');

const runDir = await recordFixtureRun('customers', parentDir);
await ffmpegRenderer.render(runDir, await buildRenderPlan(runDir));
process.stdout.write('rendered\n');
