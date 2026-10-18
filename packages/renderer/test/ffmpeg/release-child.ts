// Run by `release.spec.ts` as its own Node process, so no test runner's
// resources are counted: records and renders the `customers` fixture run
// twice, prints `rendered`, then the active resources before and after as
// one JSON line, and returns — no `process.exit`. The process ends only
// when nothing the engine or the renderer opened is left.
import path from 'node:path';
import { buildRenderPlan, ffmpegRenderer } from '../../src/index.ts';
import { recordFixtureRun } from '../plan/fixture-runs.ts';

const parentDir = process.argv[2];
if (parentDir === undefined) throw new Error('usage: release-child.ts <dir>');

/** The active resources as a sorted multiset of their types, once in-flight requests have finished. */
async function activeResources(): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return process.getActiveResourcesInfo().sort();
}

const before = await activeResources();
for (const name of ['first', 'second']) {
  const runDir = await recordFixtureRun(
    'customers',
    path.join(parentDir, name),
  );
  await ffmpegRenderer.render(runDir, await buildRenderPlan(runDir));
}
process.stdout.write('rendered\n');
const after = await activeResources();
process.stdout.write(`${JSON.stringify({ before, after })}\n`);
