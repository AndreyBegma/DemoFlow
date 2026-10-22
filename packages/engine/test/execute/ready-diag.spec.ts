// TEMPORARY (#218 diagnosis): decomposes signal → step end. Removed before the PR is ready.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type EngineObserver, runScenario } from '../../src/index.ts';
import { scenario } from './scenario.ts';

const PAGE = `<h1>Late</h1><script>setTimeout(() => { window.signalledAt = performance.now(); window.demoflow.ready('late') }, 500)</script>`;

let origin = '';
let close: () => Promise<void> = async () => undefined;
const dirs: string[] = [];

beforeAll(async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

afterAll(async () => {
  await close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Runs in the page: records every poll of the ready set, and a 5 ms heartbeat. */
function probe(): void {
  const w = window as unknown as Record<string, unknown>;
  const polls: Array<[number, boolean]> = [];
  const beats: number[] = [];
  w.polls = polls;
  w.beats = beats;
  const has = Set.prototype.has;
  Set.prototype.has = function (this: Set<unknown>, value: unknown) {
    const result = has.call(this, value);
    if (value === 'late') polls.push([window.performance.now(), result]);
    return result;
  };
  setInterval(() => beats.push(window.performance.now()), 5);
}

const RUNS = Number(process.env.DIAG_RUNS ?? 1);

it('decomposes signal → step end (#218 diagnosis)', async () => {
  for (let run = 0; run < RUNS; run++) {
    const dir = await mkdtemp(path.join(tmpdir(), 'demoflow-diag-'));
    dirs.push(dir);
    let page: Page | undefined;
    let zero = Number.POSITIVE_INFINITY;
    let resolvedAt = Number.NaN;
    let read:
      | {
          signalledAt: number;
          polls: Array<[number, boolean]>;
          beats: number[];
          shift: number;
          rtt: number;
        }
      | undefined;
    const observer: EngineObserver = {
      onPageCreated: async (event) => {
        zero = performance.now();
        page = event.page;
        await page.addInitScript(probe);
        const original = page.waitForFunction.bind(page);
        page.waitForFunction = (async (...args: Parameters<Page['waitForFunction']>) => {
          const handle = await original(...args);
          resolvedAt = performance.now();
          return handle;
        }) as Page['waitForFunction'];
      },
      onStepStarted: ({ startMs }) => {
        zero = Math.min(zero, performance.now() - startMs);
      },
      onStepFinished: async ({ stepIndex }) => {
        if (stepIndex !== 1 || page === undefined) return;
        const got = await page.evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          return {
            signalledAt: w.signalledAt as number,
            polls: w.polls as Array<[number, boolean]>,
            beats: w.beats as number[],
          };
        });
        let best = { shift: 0, rtt: Number.POSITIVE_INFINITY };
        for (let i = 0; i < 5; i++) {
          const sent = performance.now();
          const pageMs = await page.evaluate(() => window.performance.now());
          const received = performance.now();
          if (received - sent < best.rtt) {
            best = { shift: (sent + received) / 2 - pageMs, rtt: received - sent };
          }
        }
        read = { ...got, ...best };
      },
    };
    const outcome = await runScenario(
      scenario([
        { action: 'navigate', path: '/late' },
        { action: 'waitForReady', name: 'late' },
      ]),
      { runDir: dir, baseUrl: origin, allowedOrigins: [origin], env: {}, observers: [observer] },
    );
    if (outcome.stages.execution.status !== 'passed') {
      throw new Error(JSON.stringify(outcome.stages.execution));
    }
    const step = outcome.events[1];
    if (read === undefined || step === undefined) throw new Error('no read');
    // Everything on the test process's clock.
    const toTest = (pageMs: number) => pageMs + read.shift;
    const signal = toTest(read.signalledAt);
    const seen = read.polls.find(([, ready]) => ready);
    const seenAt = seen === undefined ? Number.NaN : toTest(seen[0]);
    const lastMiss = read.polls.filter(([, ready]) => !ready).at(-1);
    const endAt = step.endMs + zero;
    const around = read.beats.filter(
      (b) => b >= read.signalledAt - 100 && b <= (seen?.[0] ?? read.signalledAt) + 100,
    );
    let maxGap = 0;
    for (let i = 1; i < around.length; i++) {
      maxGap = Math.max(maxGap, around[i] - around[i - 1]);
    }
    const gaps = read.polls.slice(1).map(([t], i) => t - read.polls[i][0]);
    const r = (n: number) => Math.round(n);
    console.log(
      `DIAG run=${run} total=${r(endAt - signal)} signal→poll=${r(seenAt - signal)} poll→resolved=${r(resolvedAt - seenAt)} resolved→end=${r(endAt - resolvedAt)} lastMissBeforeSignal=${lastMiss === undefined ? 'none' : r(read.signalledAt - lastMiss[0])} pollGapMax=${r(Math.max(...gaps))} pollGapMedian=${r(gaps.sort((a, b) => a - b)[gaps.length >> 1] ?? 0)} heartbeatMaxGap=${r(maxGap)} clockRtt=${read.rtt.toFixed(1)} polls=${read.polls.length}`,
    );
  }
});
