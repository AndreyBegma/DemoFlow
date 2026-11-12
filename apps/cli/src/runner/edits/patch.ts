import {
  type BackgroundConfig,
  type ExpandedStep,
  expandScenario,
  type FragmentSource,
  type RunEdits,
  resolveFragments,
  type Scenario,
  type Timeline,
  type Zoom,
} from '@demoflow/core';

/** Decision 6: a caption this close to a step's start is that step's caption. */
export const CAPTION_SNAP_MS = 100;

/**
 * Where an expanded step came from in the authored scenario: top-level step
 * `index` of `steps`, or somewhere a patch cannot reach.
 */
export type StepSource =
  | { kind: 'step'; index: number }
  | { kind: 'setup' | 'repeat' | 'include' };

/** An RFC 6902 operation on `/steps/<n>/caption` or `/steps/<n>/zoom` only. */
export type PatchOp =
  | { op: 'add' | 'replace'; path: string; value: string | Zoom }
  | { op: 'remove'; path: string };

export interface NotExportable {
  kind: 'caption' | 'zoom' | 'trim' | 'cut' | 'card';
  /** Timeline ms, when the edit has a time. */
  at?: number;
  reason: string;
}

/** The style edits as a `demoflow.config.json` fragment. */
export interface ConfigFragment {
  render: {
    background?: BackgroundConfig;
    frame?: { enabled?: boolean; radius?: number; shadow?: boolean };
    cards?: {
      intro?: { enabled: boolean };
      scenes?: { enabled: boolean };
      outro?: { title: string; cta?: string };
    };
  };
}

/** What `edits.exported` carries, before the request id is added. */
export interface RunExport {
  scenarioPatch: PatchOp[];
  config: ConfigFragment;
  notExportable: NotExportable[];
}

/** How many expanded steps `scenario` runs, or `null` when it does not expand. */
function expandedCount(
  scenario: Scenario,
  fragments: FragmentSource | undefined,
): number | null {
  const resolution = resolveFragments(scenario, fragments);
  if (resolution.issues.length > 0) return null;
  try {
    return expandScenario(resolution.scenario).steps.length;
  } catch {
    return null;
  }
}

/**
 * The source of each expanded step of the authored scenario, in run order:
 * `setup` first, then `steps`, each entry counted by its own expansion — one
 * for a plain step, its iterations (and its caption marker) for a `repeat`,
 * the fragment's steps for an `include`. `null` when an entry does not expand.
 */
export function stepSources(
  authored: Scenario,
  fragments: FragmentSource | undefined,
): StepSource[] | null {
  const sources: StepSource[] = [];
  const repeated = (count: number | null, source: StepSource): boolean => {
    if (count === null) return false;
    for (let i = 0; i < count; i++) sources.push(source);
    return true;
  };
  for (const step of authored.setup ?? []) {
    const count =
      step.action === 'include'
        ? expandedCount({ ...authored, setup: [step], steps: [] }, fragments)
        : 1;
    if (!repeated(count, { kind: 'setup' })) return null;
  }
  for (const [index, step] of authored.steps.entries()) {
    if (step.action === 'include' || step.action === 'repeat') {
      const count = expandedCount(
        { ...authored, setup: [], steps: [step] },
        fragments,
      );
      if (!repeated(count, { kind: step.action })) return null;
    } else {
      sources.push({ kind: 'step', index });
    }
  }
  return sources;
}

/**
 * Decision 6: the steps of the run and of the scenario file are the same when
 * they have the same actions on the same locators, in the same order.
 */
export function sameSteps(
  run: readonly ExpandedStep[],
  file: readonly ExpandedStep[],
): boolean {
  return (
    run.length === file.length &&
    run.every((step, index) => {
      const other = file[index];
      return (
        other !== undefined &&
        step.action === other.action &&
        JSON.stringify(locatorOf(step)) === JSON.stringify(locatorOf(other))
      );
    })
  );
}

function locatorOf(step: ExpandedStep): unknown {
  return Reflect.get(step, 'target') ?? null;
}

function reasonOf(source: StepSource | undefined): string {
  if (source === undefined) return 'not-in-scenario';
  return source.kind === 'step' ? 'free-time' : `from-${source.kind}`;
}

export interface ExportInput {
  edits: RunEdits;
  timeline: Timeline;
  /** The scenario file as written: `include` and `repeat` kept. */
  authored: Scenario;
  /** `stepSources(authored)`: one per expanded step, by `stepIndex`. */
  sources: readonly StepSource[];
}

/**
 * Decision 6: the run's edits as a patch to the scenario file, a fragment of
 * `demoflow.config.json`, and the edits neither can hold. Pure.
 */
export function buildExport(input: ExportInput): RunExport {
  const { edits, timeline, authored, sources } = input;
  const notExportable: NotExportable[] = [];
  const captionOps = new Map<number, PatchOp>();
  const zoomOps = new Map<number, PatchOp>();
  const stepEvents = timeline.events.filter(
    (event) => event.action !== 'marker',
  );

  if (edits.captions !== undefined) {
    // What the run showed before the edits, where no step can take it.
    const shown = [
      ...timeline.events.flatMap((event) => {
        const title =
          event.caption ??
          (event.marker?.kind === 'caption' ? event.marker.title : undefined);
        return title === undefined ? [] : [{ atMs: event.startMs, title }];
      }),
      ...(timeline.annotations ?? []).filter(
        (annotation) => annotation.kind === 'caption',
      ),
    ];
    const assigned = new Map<number, string>();
    for (const caption of edits.captions) {
      const event = nearest(stepEvents, caption.startMs);
      const source =
        event === undefined ? undefined : sources[event.stepIndex];
      if (source?.kind === 'step' && !assigned.has(source.index)) {
        assigned.set(source.index, caption.text);
        continue;
      }
      // Unchanged from the run: not an edit, so nothing to report.
      const unchanged = shown.some(
        (original) =>
          original.title === caption.text &&
          Math.abs(original.atMs - caption.startMs) <= CAPTION_SNAP_MS,
      );
      if (unchanged) continue;
      notExportable.push({
        kind: 'caption',
        at: caption.startMs,
        reason: event === undefined ? 'free-time' : reasonOf(source),
      });
    }
    for (const event of stepEvents) {
      const source = sources[event.stepIndex];
      if (source?.kind !== 'step') continue;
      const current = authored.steps[source.index]?.caption;
      const path = `/steps/${source.index}/caption`;
      const text = assigned.get(source.index);
      if (text === undefined) {
        if (current !== undefined && current !== '') {
          captionOps.set(source.index, { op: 'remove', path });
        }
      } else if (text !== current) {
        captionOps.set(source.index, {
          op: current === undefined ? 'add' : 'replace',
          path,
          value: text,
        });
      }
    }
  }

  for (const entry of edits.zoom ?? []) {
    const source = sources[entry.stepIndex];
    if (source?.kind !== 'step') {
      const event = timeline.events.find(
        (item) => item.stepIndex === entry.stepIndex,
      );
      notExportable.push({
        kind: 'zoom',
        ...(event === undefined ? {} : { at: event.startMs }),
        reason: reasonOf(source),
      });
      continue;
    }
    const step = authored.steps[source.index];
    const current = step === undefined ? undefined : Reflect.get(step, 'zoom');
    if (entry.zoom === current) continue;
    if (entry.zoom === false && current === undefined) continue;
    zoomOps.set(source.index, {
      op: current === undefined ? 'add' : 'replace',
      path: `/steps/${source.index}/zoom`,
      value: entry.zoom,
    });
  }

  // #354 adds trim and cuts to the schema; no scenario field holds them.
  if (Reflect.get(edits, 'trim') !== undefined) {
    notExportable.push({ kind: 'trim', reason: 'not-in-scenario' });
  }
  const cuts: unknown = Reflect.get(edits, 'cuts');
  if (Array.isArray(cuts)) {
    for (const cut of cuts) {
      const at: unknown =
        typeof cut === 'object' && cut !== null
          ? Reflect.get(cut, 'startMs')
          : undefined;
      notExportable.push({
        kind: 'cut',
        ...(typeof at === 'number' ? { at } : {}),
        reason: 'not-in-scenario',
      });
    }
  }

  const indexes = [...new Set([...captionOps.keys(), ...zoomOps.keys()])].sort(
    (a, b) => a - b,
  );
  const scenarioPatch = indexes.flatMap((index) =>
    [captionOps.get(index), zoomOps.get(index)].filter(
      (op): op is PatchOp => op !== undefined,
    ),
  );
  return {
    scenarioPatch,
    config: { render: styleFragment(edits, notExportable) },
    notExportable,
  };
}

/** The step event that starts closest to `atMs`, within the snap. */
function nearest<T extends { startMs: number }>(
  events: readonly T[],
  atMs: number,
): T | undefined {
  let best: T | undefined;
  for (const event of events) {
    const distance = Math.abs(event.startMs - atMs);
    if (distance > CAPTION_SNAP_MS) continue;
    if (best === undefined || distance < Math.abs(best.startMs - atMs)) {
      best = event;
    }
  }
  return best;
}

/**
 * The style edits the config can hold. The intro's title is the scenario's
 * name and its subtitle the scenario's description, and the config cannot
 * remove an outro: those stay in the run.
 */
function styleFragment(
  edits: RunEdits,
  notExportable: NotExportable[],
): ConfigFragment['render'] {
  const render: ConfigFragment['render'] = {};
  if (edits.background !== undefined) render.background = edits.background;
  if (edits.frame !== undefined && Object.keys(edits.frame).length > 0) {
    render.frame = { ...edits.frame };
  }
  const cards: NonNullable<ConfigFragment['render']['cards']> = {};
  const { intro, scenes, outro } = edits.cards ?? {};
  if (intro?.enabled !== undefined) cards.intro = { enabled: intro.enabled };
  if (intro?.title !== undefined || intro?.subtitle !== undefined) {
    notExportable.push({ kind: 'card', reason: 'not-in-config' });
  }
  if (scenes?.enabled !== undefined) cards.scenes = { enabled: scenes.enabled };
  if (outro === null) {
    notExportable.push({ kind: 'card', reason: 'not-in-config' });
  } else if (outro !== undefined) {
    cards.outro = {
      title: outro.title,
      ...(outro.cta === undefined ? {} : { cta: outro.cta }),
    };
  }
  if (Object.keys(cards).length > 0) render.cards = cards;
  return render;
}

const OP_PATH = /^\/steps\/(\d+)\/(caption|zoom)$/;

/**
 * A copy of the scenario file's JSON with `ops` applied. Only the paths
 * `buildExport` makes are accepted; anything else throws.
 */
export function applyPatch(raw: unknown, ops: readonly PatchOp[]): unknown {
  const copy: unknown = structuredClone(raw);
  const steps: unknown =
    typeof copy === 'object' && copy !== null
      ? Reflect.get(copy, 'steps')
      : undefined;
  if (!Array.isArray(steps)) throw new Error('the scenario has no steps');
  for (const op of ops) {
    const match = OP_PATH.exec(op.path);
    const step: unknown = match === null ? undefined : steps[Number(match[1])];
    if (match === null || typeof step !== 'object' || step === null) {
      throw new Error(`cannot apply ${op.op} at ${op.path}`);
    }
    const key = match[2];
    if (op.op === 'remove') Reflect.deleteProperty(step, key);
    else Reflect.set(step, key, op.value);
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `patch` merged into `target`, object by object; anything else replaces. */
function merge(target: unknown, patch: Record<string, unknown>): unknown {
  const base = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    base[key] = isRecord(value) ? merge(base[key], value) : value;
  }
  return base;
}

/**
 * A copy of `demoflow.config.json` with the fragment merged into `render`.
 * The background replaces the configured one whole: its shapes differ.
 */
export function mergeConfig(raw: unknown, fragment: ConfigFragment): unknown {
  const { background, ...rest } = fragment.render;
  const config = isRecord(raw) ? { ...raw } : {};
  const render = merge(config.render, rest);
  if (background !== undefined && isRecord(render)) {
    render.background = structuredClone(background);
  }
  config.render = render;
  return config;
}
