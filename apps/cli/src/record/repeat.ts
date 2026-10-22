import {
  DATA_KEY,
  type ScenarioInput,
  type ScenarioStepInput,
  type TemplateStepInput,
} from '@demoflow/core';
import type { RecordedStep } from './steps.ts';

export type RecordedData = NonNullable<ScenarioInput['data']>;

/** The most items a data list holds (spec 165, Decision 1). */
const MAX_ITEMS = 100;

/** One fill of the selection and the lines typed for it, one line per item. */
export interface RepeatField {
  name: string;
  lines: string[];
}

export interface RepeatRequest {
  /** The selected run of steps, inclusive. */
  from: number;
  to: number;
  list: string;
  /** One per typed fill in the selection, in step order. */
  fields: RepeatField[];
}

export type RepeatResult =
  | { ok: true; steps: RecordedStep[]; data: RecordedData }
  | { ok: false; message: string };

/**
 * The value a fill types, when "Repeat over data" can take it over: not a
 * secret (`valueFrom.env`), and one line of text.
 */
export function repeatableValue(step: ScenarioStepInput): string | undefined {
  if (step.action !== 'fill' || step.valueFrom !== undefined) return undefined;
  const value = step.value ?? '';
  return value.includes('\n') ? undefined : value;
}

/** Default field names for the fills of a selection: `text`, `text2`, … */
export function defaultFieldName(position: number): string {
  return position === 0 ? 'text' : `text${position + 1}`;
}

/**
 * Wraps the recorded steps `from..to` in a `repeat` over a new data list. The
 * typed value of each fill becomes `{{item.<field>}}`, and the lines typed for
 * it become the items; every other string is kept literal.
 */
export function wrapRepeat(
  steps: readonly RecordedStep[],
  data: RecordedData,
  request: RepeatRequest,
): RepeatResult {
  const { from, to, list, fields } = request;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to >= steps.length
  ) {
    return fail('select a run of steps first');
  }
  const selected = steps.slice(from, to + 1);
  if (selected.some(({ step }) => step.action === 'repeat')) {
    return fail('a repeat cannot hold another repeat: loops are one level');
  }
  if (!DATA_KEY.test(list)) {
    return fail(`"${list}" is not a list name (letters, digits and _)`);
  }
  if (list in data) return fail(`there is already a list named "${list}"`);

  const fillAt = selected.map(({ step }) => repeatableValue(step));
  const count = fillAt.filter((value) => value !== undefined).length;
  if (count === 0) {
    return fail('the selection has no typed text to repeat over');
  }
  if (fields.length !== count) {
    return fail(`expected values for ${count} fills, got ${fields.length}`);
  }
  const names = new Set<string>();
  for (const { name } of fields) {
    if (!DATA_KEY.test(name)) {
      return fail(`"${name}" is not a field name (letters, digits and _)`);
    }
    if (names.has(name)) return fail(`the field "${name}" is used twice`);
    names.add(name);
  }
  const items = fields[0]?.lines.length ?? 0;
  if (items < 1) return fail('give at least one line');
  if (items > MAX_ITEMS) return fail(`a list holds at most ${MAX_ITEMS} items`);
  if (fields.some(({ lines }) => lines.length !== items)) {
    return fail('every field needs the same number of lines');
  }

  let position = 0;
  const inner = selected.map(({ step }, i): TemplateStepInput => {
    const kept = literal(step);
    if (fillAt[i] === undefined || kept.action !== 'fill') return kept;
    const name = fields[position++]?.name ?? '';
    return { ...kept, value: `{{item.${name}}}` };
  });
  const repeat: RecordedStep = {
    step: { action: 'repeat', each: list, steps: inner },
  };
  return {
    ok: true,
    steps: [...steps.slice(0, from), repeat, ...steps.slice(to + 1)],
    data: {
      ...data,
      [list]: Array.from({ length: items }, (_, item) =>
        Object.fromEntries(
          fields.map(({ name, lines }) => [name, lines[item] ?? '']),
        ),
      ),
    },
  };
}

/** The data lists some `repeat` still runs over; deleting a repeat drops its list. */
export function usedData(
  steps: readonly RecordedStep[],
  data: RecordedData,
): RecordedData {
  const used = new Set(
    steps.flatMap(({ step }) => (step.action === 'repeat' ? [step.each] : [])),
  );
  return Object.fromEntries(
    Object.entries(data).filter(([list]) => used.has(list)),
  );
}

/** A step inside a `repeat` reads `{{` as a placeholder; a recorded `{{` is text. */
function literal(step: ScenarioStepInput): TemplateStepInput {
  return escapeBraces(step) as TemplateStepInput;
}

function escapeBraces(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('{{', '\\{{');
  if (Array.isArray(value)) return value.map(escapeBraces);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        // A secret is named by its variable, which is never a template.
        key === 'valueFrom' ? inner : escapeBraces(inner),
      ]),
    );
  }
  return value;
}

function fail(message: string): RepeatResult {
  return { ok: false, message };
}
