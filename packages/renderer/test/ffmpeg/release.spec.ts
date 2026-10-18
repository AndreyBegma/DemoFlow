import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRenderPlan, ffmpegRenderer } from '../../src/index.ts';
import { hasFfmpeg, recordFixtureRun } from '../plan/fixture-runs.ts';

const CHILD = fileURLToPath(new URL('./release-child.ts', import.meta.url));

/** The bound from the issue: a finished render leaves nothing that keeps Node alive. */
const EXIT_WITHIN_MS = 2_000;

/** Slow CI runners record and render for minutes; past this the child is killed. */
const CHILD_TIMEOUT_MS = 300_000;

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** From `rendered` on stdout to the process exiting; undefined without the marker. */
  afterRenderMs: number | undefined;
  stderr: string;
}

/** Runs `release-child.ts` and times its exit from the moment `render` resolved. */
function runChild(parentDir: string): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, parentDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let renderedAt: number | undefined;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (renderedAt === undefined && stdout.includes('rendered\n')) {
        renderedAt = performance.now();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    let exitedAt = 0;
    child.on('error', reject);
    child.on('exit', () => {
      exitedAt = performance.now();
      clearTimeout(timer);
    });
    // `close` also waits for the child's pipes, so none is left behind.
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        afterRenderMs:
          renderedAt === undefined ? undefined : exitedAt - renderedAt,
        stderr,
      });
    });
  });
}

/**
 * The active resources as a sorted multiset of their types, once in-flight
 * requests (a file write the test runner has under way) have finished.
 */
async function activeResources(): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return process.getActiveResourcesInfo().sort();
}

describe.skipIf(!hasFfmpeg)('a finished render releases what it opened', () => {
  let parent: string;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'demoflow-release-'));
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it(
    'a process that runs and renders exits on its own, with code 0',
    async () => {
      const result = await runChild(path.join(parent, 'child'));
      expect(result.signal, result.stderr).toBeNull();
      expect(result.code, result.stderr).toBe(0);
      expect(result.afterRenderMs).toBeDefined();
      expect(result.afterRenderMs).toBeLessThan(EXIT_WITHIN_MS);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );

  it('two runs and renders in one process leave the active resources as they were', async () => {
    const before = await activeResources();
    for (const name of ['first', 'second']) {
      const runDir = await recordFixtureRun(
        'customers',
        path.join(parent, name),
      );
      await ffmpegRenderer.render(runDir, await buildRenderPlan(runDir));
    }
    expect(await activeResources()).toEqual(before);
  }, 300_000);
});
