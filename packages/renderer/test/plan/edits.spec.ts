import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Annotation,
  type CardsConfig,
  CardsConfigSchema,
  deriveRunStatus,
  type RunEdits,
  type RunResult,
  type Stages,
  type Timeline,
  type TimelineEvent,
} from '@demoflow/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRenderPlan,
  frameAt,
  PLAN_INPUTS,
  planRender,
  type RenderPlan,
  type RenderPlanOptions,
} from '../../src/index.ts';

const VIEWPORT = { width: 1280, height: 720 };

function result(failedAt?: number): RunResult {
  const passed = { status: 'passed' as const };
  const stages: Stages = {
    readiness: passed,
    execution:
      failedAt === undefined
        ? passed
        : {
            status: 'failed',
            error: { message: 'boom', stepIndex: failedAt },
          },
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
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

function timeline(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  annotations?: Annotation[],
): Timeline {
  return {
    schemaVersion: 1,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    videoFile: 'source.webm',
    events: events.map((event, stepIndex) => ({ ...event, stepIndex })),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

/** No freezes and no offset: page time is timeline time. */
function plan(
  events: Omit<TimelineEvent, 'stepIndex'>[],
  edits: Omit<RunEdits, 'schemaVersion'> | undefined,
  options: RenderPlanOptions & {
    failedAt?: number;
    annotations?: Annotation[];
  } = {},
): RenderPlan {
  const { failedAt, annotations, ...rest } = options;
  return planRender(
    {
      timeline: timeline(events, annotations),
      result: result(failedAt),
      source: {
        width: 2560,
        height: 1440,
        fps: 25,
        durationMs: 20_000,
        codec: 'vp9',
        freezes: [],
      },
      ...(edits === undefined ? {} : { edits: { schemaVersion: 1, ...edits } }),
    },
    { offsetMs: 0, frame: {}, ...rest },
  );
}

function click(
  startMs: number,
  endMs: number,
  extra: Partial<TimelineEvent> = {},
): Omit<TimelineEvent, 'stepIndex'> {
  return {
    action: 'click',
    startMs,
    endMs,
    target: { box: { x: 580, y: 346, width: 120, height: 28 } },
    pointer: { from: { x: 640, y: 360 }, to: { x: 640, y: 360 } },
    ...extra,
  };
}

const wait = (startMs: number, endMs: number) => ({
  action: 'wait' as const,
  startMs,
  endMs,
});

const maxZoom = (rendered: RenderPlan): number =>
  Math.max(1, ...rendered.camera.map((key) => key.zoom));

/** Every card off unless a test turns it on, so each test reads one kind. */
function cards(overrides: Partial<CardsConfig> = {}): CardsConfig {
  return {
    intro: { enabled: false, durationMs: 2000 },
    scenes: { enabled: false, durationMs: 1500 },
    outro: { durationMs: 2500 },
    ...overrides,
  };
}

describe('edited captions', () => {
  const events = [
    click(1000, 2000, { caption: 'Open the form' }),
    { ...wait(2000, 4000), marker: { title: 'Saved', kind: 'caption' } },
    wait(4000, 6000),
  ] as const;
  const annotations: Annotation[] = [
    { atMs: 4500, kind: 'caption', title: 'From the page' },
  ];

  it('keeps the step and page captions without edits', () => {
    const rendered = plan([...events], undefined, { annotations });
    expect(rendered.captions.map((caption) => caption.text)).toEqual([
      'Open the form',
      'Saved',
      'From the page',
    ]);
  });

  it('replaces every step and page caption with the edited list', () => {
    const rendered = plan(
      [...events],
      { captions: [{ startMs: 2500, endMs: 3700, text: 'Moved' }] },
      { annotations },
    );
    expect(rendered.captions).toEqual([
      { startMs: 2500, endMs: 3700, text: 'Moved' },
    ]);
  });

  it('maps the edited times through the idle map and the cards', () => {
    const rendered = planRender(
      {
        timeline: timeline([click(1000, 2000), wait(2000, 6000)]),
        result: result(),
        source: {
          width: 2560,
          height: 1440,
          fps: 25,
          durationMs: 20_000,
          codec: 'vp9',
          // The wait is frozen, and compressed to 400 ms.
          freezes: [{ startMs: 2000, endMs: 6000 }],
        },
        edits: {
          schemaVersion: 1,
          captions: [{ startMs: 1000, endMs: 7000, text: 'Across the wait' }],
        },
      },
      {
        offsetMs: 0,
        cards: cards({ intro: { enabled: true, durationMs: 2000 } }),
      },
    );
    const [caption] = rendered.captions;
    // After the 2 s intro; 4 s of the wait saved.
    expect(caption.startMs).toBe(3000);
    expect(caption.endMs).toBeLessThan(9000);
    expect(caption.endMs).toBeGreaterThan(caption.startMs);
  });

  it('shows no caption at all for an empty list, in the vertical output either', () => {
    const rendered = plan(
      [...events],
      { captions: [] },
      {
        annotations,
        formats: ['mp4', 'mp4-vertical'],
      },
    );
    expect(rendered.captions).toEqual([]);
    expect(rendered.vertical).toBeDefined();
    const frame = Math.round((1500 * 30) / 1000);
    expect(frameAt(rendered, frame, 'vertical').caption).toBeUndefined();
    expect(frameAt(rendered, frame).caption).toBeUndefined();
  });

  it('shows an edited caption in the vertical output at the same time', () => {
    const rendered = plan(
      [...events],
      { captions: [{ startMs: 2500, endMs: 3700, text: 'Moved' }] },
      { formats: ['mp4-vertical'] },
    );
    const frame = Math.round((3000 * 30) / 1000);
    expect(frameAt(rendered, frame, 'vertical').caption).toBe('Moved');
  });
});

describe('edited zoom', () => {
  it('zooms an unzoomed click with the default strength', () => {
    const events = [click(1000, 2000), wait(2000, 4000)];
    expect(maxZoom(plan(events, undefined))).toBe(1);
    const rendered = plan(events, { zoom: [{ stepIndex: 0, zoom: true }] });
    expect(maxZoom(rendered)).toBeCloseTo(1.35);
    // The camera arrives as the click presses.
    expect(rendered.camera).toContainEqual(
      expect.objectContaining({ atMs: 1900, zoom: 1.35 }),
    );
  });

  it('removes the zoom of a zoomed step', () => {
    const events = [click(1000, 2000, { zoom: true }), wait(2000, 4000)];
    expect(maxZoom(plan(events, undefined))).toBeCloseTo(1.35);
    const rendered = plan(events, { zoom: [{ stepIndex: 0, zoom: false }] });
    expect(rendered.camera).toEqual([]);
  });

  it('uses a number as the strength, capped by the fit rule as before', () => {
    const events = [click(1000, 2000), wait(2000, 4000)];
    expect(
      maxZoom(plan(events, { zoom: [{ stepIndex: 0, zoom: 2 }] })),
    ).toBeCloseTo(2);
    const wide = [
      click(1000, 2000, {
        target: { box: { x: 240, y: 300, width: 800, height: 40 } },
      }),
      wait(2000, 4000),
    ];
    // 90 % of 1280 over 800 px.
    expect(
      maxZoom(plan(wide, { zoom: [{ stepIndex: 0, zoom: 2 }] })),
    ).toBeCloseTo(1.44);
  });

  it('leaves a step that is not listed as recorded', () => {
    const events = [
      click(1000, 2000, { zoom: true }),
      wait(2000, 3000),
      // Far from the first target, so the camera zooms out between them.
      click(6000, 7000, {
        target: { box: { x: 40, y: 40, width: 120, height: 28 } },
      }),
      wait(7000, 8000),
    ];
    const rendered = plan(events, { zoom: [{ stepIndex: 2, zoom: 2 }] });
    expect(rendered.camera.filter((key) => key.atMs < 3000)).toEqual(
      plan(events, undefined).camera,
    );
    expect(maxZoom(rendered)).toBeCloseTo(2);
  });
});

describe('edited cards', () => {
  const events = [
    {
      action: 'marker' as const,
      startMs: 0,
      endMs: 0,
      marker: { title: 'Start', kind: 'scene' as const },
    },
    click(1000, 2000),
    wait(2000, 3000),
  ];
  const kinds = (rendered: RenderPlan) =>
    rendered.cards.map(({ kind, title, subtitle }) => ({
      kind,
      title,
      ...(subtitle === undefined ? {} : { subtitle }),
    }));

  it('retitles the intro and removes its subtitle', () => {
    const options = {
      cards: cards({ intro: { enabled: true, durationMs: 2000 } }),
      scenario: { description: 'From the list' },
    };
    expect(kinds(plan(events, undefined, options))).toEqual([
      { kind: 'intro', title: 'Create a customer', subtitle: 'From the list' },
    ]);
    expect(
      kinds(
        plan(
          events,
          { cards: { intro: { title: 'Sign up', subtitle: null } } },
          options,
        ),
      ),
    ).toEqual([{ kind: 'intro', title: 'Sign up' }]);
    expect(
      kinds(
        plan(
          events,
          { cards: { intro: { subtitle: 'In a minute' } } },
          options,
        ),
      ),
    ).toEqual([
      { kind: 'intro', title: 'Create a customer', subtitle: 'In a minute' },
    ]);
  });

  it('switches the intro and the scenes', () => {
    const options = {
      cards: cards({ scenes: { enabled: true, durationMs: 1500 } }),
    };
    expect(kinds(plan(events, undefined, options))).toEqual([
      { kind: 'scene', title: 'Start' },
    ]);
    expect(
      kinds(
        plan(
          events,
          { cards: { scenes: { enabled: false }, intro: { enabled: true } } },
          options,
        ),
      ),
    ).toEqual([{ kind: 'intro', title: 'Create a customer' }]);
  });

  it('adds an outro to a config without one, with the config’s duration', () => {
    const rendered = plan(
      events,
      { cards: { outro: { title: 'Try it', cta: 'example.com' } } },
      { cards: cards() },
    );
    expect(rendered.cards).toEqual([
      expect.objectContaining({
        kind: 'outro',
        title: 'Try it',
        subtitle: 'example.com',
        durationMs: 2500,
      }),
    ]);
  });

  it('removes the outro of a config with one', () => {
    const options = {
      cards: cards({ outro: { title: 'Thanks', durationMs: 2500 } }),
    };
    expect(kinds(plan(events, undefined, options))).toEqual([
      { kind: 'outro', title: 'Thanks' },
    ]);
    expect(plan(events, { cards: { outro: null } }, options).cards).toEqual([]);
  });

  it('never gives a failed run an outro', () => {
    const rendered = plan(
      events,
      { cards: { outro: { title: 'Try it' } } },
      { cards: cards(), failedAt: 1 },
    );
    expect(rendered.cards).toEqual([]);
    expect(rendered.failure?.watermark).toBe(true);
  });

  it('ignores card edits when the project has no cards', () => {
    const rendered = plan(events, {
      cards: { intro: { enabled: true }, outro: { title: 'Try it' } },
    });
    expect(rendered.cards).toEqual([]);
  });

  it('reads the config defaults through CardsConfigSchema', () => {
    const rendered = plan(
      events,
      { cards: { intro: { enabled: false }, scenes: { enabled: false } } },
      { cards: CardsConfigSchema.parse({}) },
    );
    expect(rendered.cards).toEqual([]);
  });
});

describe('edited style', () => {
  const events = [click(1000, 2000), wait(2000, 3000)];
  const base = plan(events, undefined);

  it('replaces the background of the window and the cards, and nothing else', () => {
    const rendered = plan(events, { background: { color: '#112233' } });
    const colour = { from: '#112233', to: '#112233', angle: 0 };
    expect(rendered.frame).toEqual({ ...base.frame, background: colour });
    expect(rendered.cardBackground).toEqual(colour);
    expect({
      ...rendered,
      frame: base.frame,
      cardBackground: base.cardBackground,
    }).toEqual(base);
  });

  it('merges the window fields over the config', () => {
    const rendered = plan(
      events,
      { frame: { radius: 0 } },
      {
        frame: { shadow: false },
      },
    );
    const configured = plan(events, undefined, { frame: { shadow: false } });
    expect(rendered.frame).toEqual({ ...configured.frame, radius: 0 });
    expect({ ...rendered, frame: configured.frame }).toEqual(configured);
  });

  it('turns the window off', () => {
    const rendered = plan(events, { frame: { enabled: false } });
    expect(rendered.frame).toBeUndefined();
    expect(rendered.fit).toEqual({ x: 0, y: 0, scale: 1.5 });
  });
});

describe('an empty edits file', () => {
  it('plans exactly what no file plans', () => {
    const events = [
      click(1000, 2000, { caption: 'Open', zoom: true }),
      {
        action: 'marker' as const,
        startMs: 2000,
        endMs: 2000,
        marker: { title: 'Next', kind: 'scene' as const },
      },
      wait(2000, 4000),
    ];
    const options = {
      cards: cards({
        intro: { enabled: true, durationMs: 2000 },
        scenes: { enabled: true, durationMs: 1500 },
        outro: { title: 'Thanks', durationMs: 2500 },
      }),
      formats: ['mp4', 'mp4-vertical', 'mp4-square'] as const,
      background: { preset: 'dusk' as const },
    };
    expect(
      plan(events, {}, { ...options, formats: [...options.formats] }),
    ).toEqual(
      plan(events, undefined, { ...options, formats: [...options.formats] }),
    );
  });
});

describe('buildRenderPlan with edits.json', () => {
  let runDir: string;

  beforeAll(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), 'demoflow-edits-'));
    await writeFile(
      path.join(runDir, PLAN_INPUTS.timeline),
      JSON.stringify(timeline([click(1000, 2000), wait(2000, 3000)])),
    );
    await writeFile(
      path.join(runDir, PLAN_INPUTS.result),
      JSON.stringify(result()),
    );
  });

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  // The edits are read and checked before the source is probed, so a run
  // without a video is enough to see them rejected.
  it.each([
    ['not JSON', '{ captions'],
    ['against its schema', JSON.stringify({ schemaVersion: 2 })],
    [
      'against the timeline',
      JSON.stringify({
        schemaVersion: 1,
        zoom: [{ stepIndex: 1, zoom: true }],
      }),
    ],
    [
      'with a caption past the end',
      JSON.stringify({
        schemaVersion: 1,
        captions: [{ startMs: 0, endMs: 60_000, text: 'Too long' }],
      }),
    ],
  ])('rejects an edits.json that is invalid %s', async (_, content) => {
    await writeFile(path.join(runDir, PLAN_INPUTS.edits), content);
    await expect(buildRenderPlan(runDir)).rejects.toThrow(/edits\.json/);
  });
});
