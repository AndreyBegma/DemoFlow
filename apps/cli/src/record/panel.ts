import type { Locator, MarkerKind, StepInput } from '@demoflow/core';
import type { CaptureMode } from './capture-script.ts';
import type { RecordedStep } from './steps.ts';

/** The binding the panel page calls with a `PanelCommand`. */
export const PANEL_BINDING = '__demoflowPanel';

export type PanelCommand =
  | { type: 'mode'; mode: CaptureMode }
  | { type: 'marker'; kind: MarkerKind; title: string }
  | { type: 'wait'; ms: number }
  | { type: 'remove'; index: number }
  | { type: 'move'; index: number; delta: number }
  | { type: 'secretEnv'; name: string }
  | { type: 'stop' };

export interface PanelState {
  steps: { summary: string; warning?: string }[];
  mode: CaptureMode;
  secretEnv: string;
  /** The last problem to show, e.g. an element no locator could reach. */
  notice?: string;
}

export function panelState(
  steps: readonly RecordedStep[],
  mode: CaptureMode,
  secretEnv: string,
  notice?: string,
): PanelState {
  return {
    steps: steps.map(({ step, warning }) => ({
      summary: describeStep(step),
      ...(warning === undefined ? {} : { warning }),
    })),
    mode,
    secretEnv,
    ...(notice === undefined ? {} : { notice }),
  };
}

export function describeLocator(locator: Locator): string {
  if ('role' in locator) {
    return locator.name === undefined
      ? locator.role
      : `${locator.role} "${locator.name}"`;
  }
  const [kind, value] = Object.entries(locator)[0] ?? ['', ''];
  return `${kind} "${String(value)}"`;
}

/** One line per step. A secret fill shows the variable name, never a value. */
export function describeStep(step: StepInput): string {
  switch (step.action) {
    case 'navigate':
      return `navigate ${step.path ?? step.url ?? ''}`;
    case 'fill':
      return step.valueFrom === undefined
        ? `fill ${describeLocator(step.target)} = "${step.value ?? ''}"`
        : `fill ${describeLocator(step.target)} ← env ${step.valueFrom.env}`;
    case 'select':
      return `select ${describeLocator(step.target)} = "${step.option}"`;
    case 'assertText':
      return `assert text ${describeLocator(step.target)} ~ "${step.text}"`;
    case 'assertVisible':
      return `assert visible ${describeLocator(step.target)}`;
    case 'scroll':
      return step.target === undefined
        ? `scroll to ${step.to ?? ''}`
        : `scroll to ${describeLocator(step.target)}`;
    case 'marker':
      return `${step.kind ?? 'scene'}: ${step.title}`;
    case 'wait':
      return `wait ${step.ms} ms`;
    case 'screenshot':
      return `screenshot ${step.name}`;
    default:
      return `${step.action} ${describeLocator(step.target)}`;
  }
}

/**
 * The step panel, a page of its own in a separate window (spec #79,
 * Decision 1). `render(state)` is called by the recorder after every change.
 */
export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DemoFlow — recording</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
  body { margin: 0; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  h1 { font-size: 15px; margin: 0; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  input { flex: 1; min-width: 0; padding: 4px 6px; font: inherit; }
  button { padding: 4px 8px; font: inherit; cursor: pointer; }
  button[aria-pressed="true"] { outline: 2px solid #2563eb; }
  #stop { background: #dc2626; color: white; border: 0; border-radius: 4px; padding: 6px 10px; }
  #mode { font-weight: 600; }
  #notice { color: #b45309; min-height: 1em; }
  ol { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 4px; }
  li .summary { word-break: break-word; }
  li .warning { color: #b45309; font-size: 12px; display: block; }
  li .tools { display: inline-flex; gap: 2px; margin-left: 4px; }
  li .tools button { padding: 0 5px; }
</style>
</head>
<body>
  <h1>Recording</h1>
  <div>Mode: <span id="mode">record</span></div>
  <div class="row">
    <input id="title" aria-label="Title" placeholder="Scene or caption text">
    <button id="scene">Scene</button>
    <button id="caption">Caption</button>
  </div>
  <div class="row">
    <input id="ms" aria-label="Milliseconds" type="number" min="1" max="5000" value="1000">
    <button id="wait">Wait</button>
  </div>
  <div class="row">
    <button data-mode="pick-visible">Pick: visible</button>
    <button data-mode="pick-text">Pick: text</button>
    <button data-mode="hover">Hover next</button>
    <button data-mode="secret-next">Secret next</button>
  </div>
  <div class="row">
    <input id="env" aria-label="Secret variable" value="DEMO_PASSWORD">
  </div>
  <div id="notice" role="status"></div>
  <ol id="steps" aria-label="Steps"></ol>
  <button id="stop">Stop and save</button>
<script>
  const send = (command) => window.${PANEL_BINDING}(command);
  const $ = (id) => document.getElementById(id);
  const marker = (kind) => {
    const title = $('title').value.trim();
    if (!title) return $('title').focus();
    send({ type: 'marker', kind, title });
    $('title').value = '';
  };
  $('scene').onclick = () => marker('scene');
  $('caption').onclick = () => marker('caption');
  $('wait').onclick = () => send({ type: 'wait', ms: Number($('ms').value) });
  $('env').onchange = () => send({ type: 'secretEnv', name: $('env').value.trim() });
  $('stop').onclick = () => send({ type: 'stop' });
  let current = 'record';
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.onclick = () => send({ type: 'mode',
      mode: current === button.dataset.mode ? 'record' : button.dataset.mode });
  }
  window.render = (state) => {
    current = state.mode;
    $('mode').textContent = state.mode;
    for (const button of document.querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    }
    if (document.activeElement !== $('env')) $('env').value = state.secretEnv;
    $('notice').textContent = state.notice || '';
    const list = $('steps');
    list.replaceChildren(...state.steps.map((step, index) => {
      const item = document.createElement('li');
      const summary = document.createElement('span');
      summary.className = 'summary';
      summary.textContent = step.summary;
      const tools = document.createElement('span');
      tools.className = 'tools';
      for (const [label, text, command] of [
        ['Move step ' + (index + 1) + ' up', '↑', { type: 'move', index, delta: -1 }],
        ['Move step ' + (index + 1) + ' down', '↓', { type: 'move', index, delta: 1 }],
        ['Delete step ' + (index + 1), '✕', { type: 'remove', index }],
      ]) {
        const button = document.createElement('button');
        button.textContent = text;
        button.setAttribute('aria-label', label);
        button.onclick = () => send(command);
        tools.append(button);
      }
      item.append(summary, tools);
      if (step.warning) {
        const warning = document.createElement('span');
        warning.className = 'warning';
        warning.textContent = '⚠ ' + step.warning;
        item.append(warning);
      }
      return item;
    }));
  };
</script>
</body>
</html>
`;
