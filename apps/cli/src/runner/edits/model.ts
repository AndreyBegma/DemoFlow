import type {
  Box,
  ProjectConfig,
  RunEdits,
  RunResult,
  Timeline,
  Zoom,
} from '@demoflow/core';
import { reportedRenders } from '../../runs-report/report.ts';

/** One step of the run as the editor draws it (ADR-0020 §4). */
export interface ModelEvent {
  stepIndex: number;
  action: string;
  startMs: number;
  endMs: number;
  box: Box | null;
  zoom: Zoom | null;
  caption: string | null;
  scene: string | null;
}

/** A segment of the current render: output time back to timeline time. */
export interface ModelSegment {
  outputStartMs: number;
  outputEndMs: number;
  timelineStartMs: number;
  timelineEndMs: number;
}

/** What `edits.model` carries (spec 355, Protocol). */
export interface EditModel {
  runId: string;
  scenarioName: string;
  description: string | null;
  failed: boolean;
  failedStepIndex: number | null;
  durationMs: number;
  events: ModelEvent[];
  pageCaptions: Array<{ atMs: number; title: string }>;
  pageScenes: Array<{ atMs: number; title: string }>;
  style: {
    background: ProjectConfig['render']['background'];
    frame: ProjectConfig['render']['frame'];
    cards: ProjectConfig['render']['cards'];
  };
  edits: RunEdits | null;
  timeMap: ModelSegment[];
  renders: Array<{
    format: string;
    width: number;
    height: number;
    sizeBytes: number;
    durationMs: number;
  }>;
}

/** The part of a render plan the model needs: source-time segments and the offset. */
export interface PlanMap {
  offsetMs: number;
  timeMap: ReadonlyArray<{
    outputStartMs: number;
    outputEndMs: number;
    sourceStartMs: number;
    sourceEndMs: number;
  }>;
}

export interface ModelInput {
  /** The server's id of the run: the one the request named. */
  runId: string;
  timeline: Timeline;
  result: RunResult;
  edits: RunEdits | null;
  config: ProjectConfig;
  description: string | undefined;
  /** The plan of the next render, or `null` when it could not be built. */
  plan: PlanMap | null;
}

/**
 * The end of the timeline range an edit may reach: the last event and its
 * hold, then the end hold the renderer keeps (what `checkRunEdits` allows).
 */
export function editableEndMs(timeline: Timeline, endHoldMs: number): number {
  const last = timeline.events.at(-1);
  return (last === undefined ? 0 : last.endMs + (last.holdMs ?? 0)) + endHoldMs;
}

/**
 * Decision 2: the edit model, built field by field from an allow-list. No
 * typed value, screenshot, pointer, scroll, locator or URL is ever copied: a
 * field is in the model only when this function names it.
 */
export function buildEditModel(input: ModelInput): EditModel {
  const { timeline, result, config, plan } = input;
  const failedStepIndex = Object.values(result.stages)
    .map((stage) => stage.error?.stepIndex)
    .find((index) => index !== undefined);
  const annotations = timeline.annotations ?? [];
  return {
    runId: input.runId,
    scenarioName: result.scenarioName,
    description: input.description ?? null,
    failed: result.status === 'failed',
    failedStepIndex: failedStepIndex ?? null,
    durationMs: editableEndMs(timeline, config.render.endHoldMs),
    events: timeline.events.map((event) => ({
      stepIndex: event.stepIndex,
      action: event.action,
      startMs: event.startMs,
      endMs: event.endMs,
      box: event.target === undefined ? null : copyBox(event.target.box),
      zoom: event.zoom ?? null,
      caption:
        event.caption ??
        (event.marker?.kind === 'caption' ? event.marker.title : null),
      scene: event.marker?.kind === 'scene' ? event.marker.title : null,
    })),
    pageCaptions: annotations
      .filter((annotation) => annotation.kind === 'caption')
      .map(({ atMs, title }) => ({ atMs, title })),
    pageScenes: annotations
      .filter((annotation) => annotation.kind === 'scene')
      .map(({ atMs, title }) => ({ atMs, title })),
    style: {
      background: config.render.background,
      frame: config.render.frame,
      cards: config.render.cards,
    },
    edits: input.edits,
    timeMap:
      plan === null
        ? []
        : plan.timeMap.map((segment) => ({
            outputStartMs: Math.round(segment.outputStartMs),
            outputEndMs: Math.round(segment.outputEndMs),
            // Source time is timeline time shifted by the plan's offset.
            timelineStartMs: Math.round(segment.sourceStartMs - plan.offsetMs),
            timelineEndMs: Math.round(segment.sourceEndMs - plan.offsetMs),
          })),
    renders: reportedRenders(result),
  };
}

function copyBox(box: Box): Box {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}
