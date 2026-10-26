import {
  type CardsConfig,
  deriveRunStatus,
  MAX_CHAPTERS,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import { planChapters, planRender, type VideoProbe } from '../../src/index.ts';

function result(): RunResult {
  const passed = { status: 'passed' as const };
  const stages: Stages = {
    readiness: passed,
    execution: passed,
    verification: passed,
    recording: passed,
    rendering: { status: 'pending' },
    storage: { status: 'pending' },
  };
  return {
    schemaVersion: 1,
    runId: 'run',
    scenarioId: 'inline',
    scenarioName: 'Create a customer',
    startedAt: '2026-10-18T10:00:00.000Z',
    finishedAt: '2026-10-18T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

const CARDS: CardsConfig = {
  intro: { enabled: true, durationMs: 2000 },
  scenes: { enabled: true, durationMs: 1500 },
  outro: { title: 'Thanks', durationMs: 2500 },
};

const scene = (atMs: number, title: string) => ({
  action: 'marker' as const,
  startMs: atMs,
  endMs: atMs,
  marker: { title, kind: 'scene' as const },
});

const wait = (startMs: number, endMs: number) => ({
  action: 'wait' as const,
  startMs,
  endMs,
});

function plan(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  freezes: VideoProbe['freezes'] = [],
  cards: CardsConfig = CARDS,
) {
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        videoFile: 'source.webm',
        events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
      },
      result: result(),
      source: {
        width: 2560,
        height: 1440,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes,
      },
    },
    { offsetMs: 0, cards },
  );
}

describe('planChapters (spec 349)', () => {
  it('gives one chapter per scene card, at its output start, without the intro and outro', () => {
    const rendered = plan([scene(1000, 'Sign in'), scene(4000, 'Invoices')]);
    expect(rendered.cards.map((card) => card.kind)).toEqual([
      'intro',
      'scene',
      'scene',
      'outro',
    ]);
    // After the 2 s intro; the second also after the first 1.5 s scene card.
    expect(planChapters(rendered)).toEqual([
      { title: 'Sign in', atMs: 3000 },
      { title: 'Invoices', atMs: 7500 },
    ]);
  });

  it('places a scene after a trimmed idle stretch where the card is drawn', () => {
    // The 4 s wait is frozen and plays in 400 ms: 3.6 s saved before the scene.
    const rendered = plan(
      [wait(1000, 5000), scene(6000, 'Invoices')],
      [{ startMs: 1000, endMs: 5000 }],
    );
    const [chapter] = planChapters(rendered);
    const card = rendered.cards.find((entry) => entry.kind === 'scene');
    expect(chapter).toEqual({ title: 'Invoices', atMs: card?.startMs });
    expect(chapter.atMs).toBe(2000 + 6000 - 3600);
  });

  it('is empty without scenes, or with scene cards off', () => {
    expect(planChapters(plan([wait(0, 1000)]))).toEqual([]);
    expect(
      planChapters(
        plan([scene(1000, 'Sign in')], [], {
          ...CARDS,
          scenes: { enabled: false, durationMs: 1500 },
        }),
      ),
    ).toEqual([]);
  });

  it('keeps at most MAX_CHAPTERS, each title at most 200 characters', () => {
    const chapters = planChapters({
      cards: Array.from({ length: MAX_CHAPTERS + 5 }, (_, index) => ({
        kind: 'scene' as const,
        startMs: index * 1000 + 0.4,
        durationMs: 1500,
        title: index === 0 ? 'x'.repeat(250) : `Scene ${index}`,
      })),
    });
    expect(chapters).toHaveLength(MAX_CHAPTERS);
    expect(chapters[0]).toEqual({ title: 'x'.repeat(200), atMs: 0 });
    expect(chapters[1]).toEqual({ title: 'Scene 1', atMs: 1000 });
  });
});
