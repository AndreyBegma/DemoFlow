import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseScenario, type Scenario, TimelineSchema } from '@demoflow/core';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCaptureObserver, runScenario } from '../../src/index.ts';
import { webmFrameSize } from '../capture/webm.ts';
import {
  FIXTURE_DIST,
  type FixtureServer,
  startFixtureServer,
} from './fixture-server.ts';

let fixture: FixtureServer;
let runDir: string;

beforeAll(async () => {
  fixture = await startFixtureServer();
  runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-phone-'));
});

afterAll(async () => {
  await fixture.close();
  await rm(runDir, { recursive: true, force: true });
});

describe('phone.demo.json', () => {
  it('records as a touch phone', async () => {
    const raw = await readFile(
      path.join(FIXTURE_DIST, '..', 'demoflow', 'phone.demo.json'),
      'utf8',
    );
    const parsed = parseScenario(JSON.parse(raw));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const scenario: Scenario = parsed.value;
    expect(scenario.viewport).toEqual({ width: 412, height: 914 });

    const probes: { coarse: boolean; userAgent: string }[] = [];
    let page: Page | undefined;
    const outcome = await runScenario(scenario, {
      runDir,
      baseUrl: fixture.origin,
      allowedOrigins: [fixture.origin],
      env: { FIXTURE_PASSWORD: 'hunter2-correct-horse' },
      observers: [
        {
          onPageCreated: (event) => {
            page = event.page;
          },
          // The click and the fill have passed by the time the last step ends.
          onStepFinished: async ({ stepIndex }) => {
            if (stepIndex !== 0 || page === undefined) return;
            probes.push(
              await page.evaluate(() => ({
                coarse: matchMedia('(pointer: coarse)').matches,
                userAgent: navigator.userAgent,
              })),
            );
          },
        },
        createCaptureObserver({ scenarioId: 'demoflow/phone.demo.json' }),
      ],
    });

    expect(outcome.stages.execution.status).toBe('passed');
    expect(outcome.events.map((event) => event.action)).toEqual([
      'navigate',
      'fill',
      'fill',
      'click',
      'assertText',
    ]);
    expect(probes[0]?.coarse).toBe(true);
    expect(probes[0]?.userAgent).toContain('Mobile');
    expect(probes[0]?.userAgent).toContain('Android');

    const video = await readFile(path.join(runDir, 'source.webm'));
    // The default phone height is even because Playwright floors the video
    // frame to even dimensions: the video and the timeline agree.
    expect(webmFrameSize(video)).toEqual({ width: 412, height: 914 });

    const timeline = TimelineSchema.parse(
      JSON.parse(await readFile(path.join(runDir, 'timeline.json'), 'utf8')),
    );
    expect(timeline.device).toBe('phone');
    expect(timeline.viewport).toEqual({ width: 412, height: 914 });
  });
});
