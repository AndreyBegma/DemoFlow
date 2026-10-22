import {
  deriveRunStatus,
  type RunResult,
  type Stages,
  type TimelineEvent,
} from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import { frameAt, frameCount, planRender } from '../../src/index.ts';

const VIEWPORT = { width: 1280, height: 720 };
const FPS = 25;
const SLOT_MS = 1000 / FPS;
const PASSWORD = { x: 264, y: 230, width: 384, height: 28 };
/** Cleared on source frame 3 (120 ms), the page's `offMs` 180: offset −60 ms. */
const MARK = { colour: '#ff00ff', onMs: 25, offMs: 180 };
const CLEAR_MS = 120;
const OFFSET_MS = CLEAR_MS - MARK.offMs;
/** The page's own frames: the field is drawn from here, and the first frame without it is here. */
const SHOWN_MS = 600;
const GONE_MS = 2000;

function passed(): RunResult {
  const ok = { status: 'passed' as const };
  const stages: Stages = {
    readiness: ok,
    execution: ok,
    verification: ok,
    recording: ok,
    rendering: { status: 'pending' },
    storage: { status: 'pending' },
  };
  return {
    schemaVersion: 1,
    runId: 'run',
    scenarioId: 'inline',
    scenarioName: 'inline',
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: '2026-10-22T10:00:10.000Z',
    status: deriveRunStatus(stages),
    stages,
    renders: [],
    warnings: [],
  };
}

function plan() {
  const events: TimelineEvent[] = [
    { stepIndex: 0, action: 'navigate', startMs: 180, endMs: 500 },
    {
      stepIndex: 1,
      action: 'fill',
      startMs: SHOWN_MS,
      endMs: 1600,
      target: { box: PASSWORD },
      masked: true,
      value: '***',
      maskVisibility: [{ startMs: SHOWN_MS, endMs: GONE_MS, box: PASSWORD }],
    },
    { stepIndex: 2, action: 'click', startMs: 1700, endMs: 2200 },
    { stepIndex: 3, action: 'wait', startMs: 2200, endMs: 3500 },
  ];
  return planRender(
    {
      timeline: {
        schemaVersion: 1,
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        videoFile: 'source.webm',
        events,
        syncMark: MARK,
      },
      result: passed(),
      source: {
        width: 2560,
        height: 1440,
        fps: FPS,
        durationMs: 5000,
        codec: 'vp9',
        freezes: [],
      },
      syncClearMs: CLEAR_MS,
    },
    { frame: { enabled: false } },
  );
}

/**
 * #185: the watch stamps the page's frames exactly, but a frame lands in the
 * 25 fps source up to a slot off the stamp mapped through the sync offset —
 * the slot rounding of that frame and of the mark's clear, and the
 * screencast's delivery of each. Measured on ubuntu, macOS and Windows, −26 to
 * +29 ms in 30 runs, and past +40 ms once on Windows CI (frame 171). A mask
 * padded by one source frame showed the field on that frame.
 *
 * Here the source shows the field on every slot that starts within `lagMs`
 * of the page's frames: from the slot `lagMs` early to the slot `lagMs` late.
 * Every output frame that draws one of those slots has the field covered.
 */
describe.each([
  80, -80,
])('a source frame landing %i ms off the page stamp', (lagMs) => {
  it('is covered by the mask on every output frame that draws it', () => {
    const rendered = plan();
    expect(rendered.offsetMs).toBe(OFFSET_MS);
    const early = Math.min(0, lagMs);
    const late = Math.max(0, lagMs);
    const firstSlot =
      Math.floor((SHOWN_MS + OFFSET_MS + early) / SLOT_MS) * SLOT_MS;
    const goneSlot =
      Math.ceil((GONE_MS + OFFSET_MS + late) / SLOT_MS) * SLOT_MS;
    const shows = (sourceMs: number): boolean => {
      const slot = Math.floor(sourceMs / SLOT_MS + 1e-6) * SLOT_MS;
      return slot >= firstSlot && slot < goneSlot;
    };
    let checked = 0;
    for (let n = 0; n < frameCount(rendered); n++) {
      const { sourceMs, masks } = frameAt(rendered, n);
      if (sourceMs === null || !shows(sourceMs)) continue;
      checked++;
      expect(
        masks.length,
        `frame ${n} (source ${sourceMs.toFixed(1)} ms) shows the field unmasked`,
      ).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(30);
  });
});
