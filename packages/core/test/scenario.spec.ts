import { describe, expect, it } from 'vitest';
import {
  type Issue,
  parseScenario,
  resolvePacing,
  type StepAction,
} from '../src/index.ts';

function scenario(...steps: unknown[]) {
  return { schemaVersion: 1, name: 'Demo', steps };
}

function errorsOf(input: unknown): Issue[] {
  const result = parseScenario(input);
  if (result.ok) throw new Error('expected the scenario to be rejected');
  return result.errors;
}

const target = { testId: 'save' };

// One valid example per action, the field whose absence must be reported, and
// the path the error is reported at.
const actions: {
  action: StepAction;
  valid: Record<string, unknown>;
  required: string;
  errorPath: string;
}[] = [
  // `path` and `url` are alternatives: without either the step is reported.
  {
    action: 'navigate',
    valid: { path: '/login' },
    required: 'path',
    errorPath: 'steps[0]',
  },
  {
    action: 'waitFor',
    valid: { target, state: 'hidden' },
    required: 'target',
    errorPath: 'steps[0].target',
  },
  {
    action: 'click',
    valid: { target },
    required: 'target',
    errorPath: 'steps[0].target',
  },
  {
    action: 'fill',
    valid: { target, value: 'ada@example.com' },
    required: 'target',
    errorPath: 'steps[0].target',
  },
  {
    action: 'select',
    valid: { target, option: 'Monthly' },
    required: 'option',
    errorPath: 'steps[0].option',
  },
  {
    action: 'hover',
    valid: { target },
    required: 'target',
    errorPath: 'steps[0].target',
  },
  {
    action: 'press',
    valid: { key: 'Enter', target },
    required: 'key',
    errorPath: 'steps[0].key',
  },
  {
    action: 'scroll',
    valid: { to: 'bottom' },
    required: 'to',
    errorPath: 'steps[0]',
  },
  {
    action: 'assertVisible',
    valid: { target },
    required: 'target',
    errorPath: 'steps[0].target',
  },
  {
    action: 'assertText',
    valid: { target, text: 'Saved', match: 'exact' },
    required: 'text',
    errorPath: 'steps[0].text',
  },
  {
    action: 'screenshot',
    valid: { name: 'dashboard-1' },
    required: 'name',
    errorPath: 'steps[0].name',
  },
  {
    action: 'marker',
    valid: { title: 'Sign in', kind: 'caption' },
    required: 'title',
    errorPath: 'steps[0].title',
  },
  {
    action: 'wait',
    valid: { ms: 500 },
    required: 'ms',
    errorPath: 'steps[0].ms',
  },
  {
    action: 'waitForReady',
    valid: { name: 'customers-loaded' },
    required: 'name',
    errorPath: 'steps[0].name',
  },
];

describe('parseScenario — waitForReady', () => {
  const ready = (extra: Record<string, unknown>) =>
    scenario({ action: 'waitForReady', ...extra });

  it.each([
    'a',
    'customers-loaded',
    'app.ready:v2_1',
    '9lives',
    'x'.repeat(64),
  ])('accepts the name %s', (name) => {
    expect(parseScenario(ready({ name })).ok).toBe(true);
  });

  it.each([
    '',
    ' lead',
    'bad name!',
    '-dash',
    '_under',
    'tail/slash',
    'x'.repeat(65),
  ])('rejects the name %j with the format message', (name) => {
    expect(errorsOf(ready({ name }))).toEqual([
      expect.objectContaining({
        path: 'steps[0].name',
        message:
          'expected 1–64 characters: letters, digits and . _ : -, starting with a letter or digit',
      }),
    ]);
  });

  it('rejects a name that is not a string', () => {
    expect(errorsOf(ready({ name: 42 }))).toEqual([
      expect.objectContaining({ path: 'steps[0].name' }),
    ]);
  });

  it('rejects a target', () => {
    expect(errorsOf(ready({ name: 'a', target }))).toEqual([
      {
        path: 'steps[0].target',
        code: 'unrecognized_keys',
        message: 'unknown field',
      },
    ]);
  });

  it('rejects a zoom', () => {
    expect(errorsOf(ready({ name: 'a', zoom: true }))).toEqual([
      {
        path: 'steps[0].zoom',
        code: 'unrecognized_keys',
        message: 'unknown field',
      },
    ]);
  });

  it('applies the common defaults', () => {
    expect(parseScenario(ready({ name: 'a' }))).toMatchObject({
      ok: true,
      value: { steps: [{ name: 'a', timeoutMs: 10_000 }] },
    });
  });
});

describe('parseScenario — device', () => {
  const step = { action: 'navigate', path: '/' };
  const input = (extra: Record<string, unknown>) => ({
    ...scenario(step),
    ...extra,
  });
  const parse = (extra: Record<string, unknown>) => parseScenario(input(extra));

  it('defaults to a desktop at 1920x1080', () => {
    expect(parse({})).toMatchObject({
      ok: true,
      value: { device: 'desktop', viewport: { width: 1920, height: 1080 } },
    });
  });

  it('gives a phone 412x914 when it sets no viewport', () => {
    expect(parse({ device: 'phone' })).toMatchObject({
      ok: true,
      value: { device: 'phone', viewport: { width: 412, height: 914 } },
    });
  });

  it('keeps an explicit viewport on a phone', () => {
    expect(
      parse({ device: 'phone', viewport: { width: 1280, height: 720 } }),
    ).toMatchObject({
      ok: true,
      value: { device: 'phone', viewport: { width: 1280, height: 720 } },
    });
  });

  it.each(['tablet', 'Phone', 1])('rejects device %j at device', (device) => {
    expect(errorsOf(input({ device })).map((issue) => issue.path)).toEqual([
      'device',
    ]);
  });
});

describe('parseScenario — press', () => {
  const press = (extra: Record<string, unknown>) =>
    parseScenario(scenario({ action: 'press', ...extra }));

  it.each([
    'Enter',
    'Tab',
    'Escape',
    'ArrowDown',
    'F5',
    'Control+a',
    'Meta+k',
    'Control+Shift+ArrowLeft',
  ])('accepts %s', (key) => {
    expect(press({ key }).ok).toBe(true);
  });

  it('accepts a press without a target, for the focused element', () => {
    expect(press({ key: 'Enter' }).ok).toBe(true);
  });

  it.each([
    '',
    'Enterr',
    'enter',
    'a',
    '1',
    'hello',
    'Control+',
    '+a',
    'Ctrl+a',
    'Control+Control+a',
    'Control+ab',
    'Enter+Enter',
  ])('rejects %j', (key) => {
    expect(errorsOf(scenario({ action: 'press', key }))).toContainEqual(
      expect.objectContaining({ path: 'steps[0].key' }),
    );
  });
});

describe('parseScenario — zoom', () => {
  const zoomOf = (step: Record<string, unknown>) => {
    const result = parseScenario(scenario(step));
    if (!result.ok) throw new Error('expected the scenario to parse');
    const [parsed] = result.value.steps;
    return parsed !== undefined && 'zoom' in parsed ? parsed.zoom : undefined;
  };

  it.each([
    { action: 'click', target },
    { action: 'fill', target, value: 'Ada' },
    { action: 'select', target, option: 'Monthly' },
    { action: 'hover', target },
    { action: 'waitFor', target },
    { action: 'press', key: 'Enter', target },
    { action: 'assertVisible', target },
    { action: 'assertText', target, text: 'Saved' },
  ])('accepts zoom on $action', (step) => {
    expect(zoomOf({ ...step, zoom: true })).toBe(true);
  });

  it.each([true, false, 1, 2, 3])('accepts zoom %j', (zoom) => {
    expect(zoomOf({ action: 'click', target, zoom })).toBe(zoom);
  });

  it('is absent unless the step sets it', () => {
    expect(zoomOf({ action: 'click', target })).toBeUndefined();
  });

  it.each([0, 0.9, 3.1, 'yes'])('rejects zoom %j at steps[n].zoom', (zoom) => {
    expect(errorsOf(scenario({ action: 'click', target, zoom }))).toEqual([
      expect.objectContaining({ path: 'steps[0].zoom' }),
    ]);
  });

  it.each([
    { action: 'navigate', path: '/login' },
    { action: 'scroll', to: 'bottom' },
    { action: 'screenshot', name: 'done' },
    { action: 'marker', title: 'Sign in' },
    { action: 'wait', ms: 500 },
  ])('rejects zoom on $action, which has no target', (step) => {
    expect(errorsOf(scenario(step, { ...step, zoom: true }))).toEqual([
      {
        path: 'steps[1].zoom',
        code: 'unrecognized_keys',
        message: 'unknown field',
      },
    ]);
  });

  it('rejects zoom on a press without a target', () => {
    expect(
      errorsOf(scenario({ action: 'press', key: 'Enter', zoom: true })),
    ).toEqual([
      expect.objectContaining({
        path: 'steps[0].zoom',
        message: 'expected zoom only on a press with a target',
      }),
    ]);
  });

  it('rejects zoom on a waitFor for a hidden target', () => {
    expect(
      errorsOf(
        scenario({ action: 'waitFor', target, state: 'hidden', zoom: true }),
      ),
    ).toEqual([
      expect.objectContaining({
        path: 'steps[0].zoom',
        message: 'expected no zoom on a waitFor for a hidden target',
      }),
    ]);
  });
});

describe('parseScenario — every action', () => {
  it('covers every action of ADR-0003', () => {
    expect(actions.map((row) => row.action).sort()).toEqual(
      [
        'navigate',
        'waitFor',
        'click',
        'fill',
        'select',
        'hover',
        'press',
        'scroll',
        'assertVisible',
        'assertText',
        'screenshot',
        'marker',
        'wait',
        'waitForReady',
      ].sort(),
    );
  });

  describe.each(actions)('$action', ({
    action,
    valid,
    required,
    errorPath,
  }) => {
    it('parses a valid example', () => {
      const result = parseScenario(scenario({ action, ...valid }));
      expect(result).toMatchObject({ ok: true, warnings: [] });
    });

    it(`rejects a missing ${required} at ${errorPath}`, () => {
      const { [required]: _dropped, ...rest } = valid;
      expect(errorsOf(scenario({ action, ...rest }))).toContainEqual(
        expect.objectContaining({ path: errorPath }),
      );
    });

    it.each([100, 10_000])('accepts hold %d (spec 365)', (hold) => {
      const result = parseScenario(scenario({ action, ...valid, hold }));
      expect(result).toMatchObject({
        ok: true,
        value: { steps: [expect.objectContaining({ hold })] },
      });
    });

    it.each([-1, 10_001, 500.5])('rejects hold %d at steps[0].hold', (hold) => {
      expect(errorsOf(scenario({ action, ...valid, hold }))).toContainEqual(
        expect.objectContaining({ path: 'steps[0].hold' }),
      );
    });

    it('rejects hold on an off-camera step (spec 365)', () => {
      expect(
        errorsOf(scenario({ action, ...valid, hold: 1500, record: false })),
      ).toContainEqual({
        path: 'steps[0].hold',
        code: 'custom',
        message: 'expected no hold on an off-camera step (record: false)',
      });
    });

    it('rejects an unknown field at its path', () => {
      expect(
        errorsOf(scenario({ action, ...valid, colour: 'red' })),
      ).toContainEqual({
        path: 'steps[0].colour',
        code: 'unrecognized_keys',
        message: 'unknown field',
      });
    });
  });

  it('rejects an unknown action at steps[n].action', () => {
    expect(errorsOf(scenario({ action: 'teleport' }))).toEqual([
      expect.objectContaining({ path: 'steps[0].action' }),
    ]);
  });
});

describe('parseScenario — fill', () => {
  it('accepts valueFrom an environment variable', () => {
    const result = parseScenario(
      scenario({ action: 'fill', target, valueFrom: { env: 'DEMO_PASSWORD' } }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects both value and valueFrom on one fill', () => {
    expect(
      errorsOf(
        scenario({
          action: 'fill',
          target,
          value: 'hunter2',
          valueFrom: { env: 'DEMO_PASSWORD' },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        path: 'steps[0]',
        message: 'expected exactly one of value|valueFrom',
      }),
    ]);
  });

  it('rejects an env name that is not an environment variable name', () => {
    expect(
      errorsOf(
        scenario({ action: 'fill', target, valueFrom: { env: 'demo-pass' } }),
      ),
    ).toEqual([expect.objectContaining({ path: 'steps[0].valueFrom.env' })]);
  });
});

describe('parseScenario — locators', () => {
  it.each([
    { role: 'button', name: 'Save', exact: true },
    { label: 'Email', exact: false },
    { testId: 'save' },
    { text: 'Welcome back' },
    { placeholder: 'Search' },
  ])('accepts %o without a warning', (locator) => {
    expect(
      parseScenario(scenario({ action: 'click', target: locator })),
    ).toMatchObject({ ok: true, warnings: [] });
  });

  it('rejects a locator with two keys', () => {
    expect(
      errorsOf(
        scenario({ action: 'click', target: { role: 'button', testId: 'x' } }),
      ),
    ).toEqual([
      {
        path: 'steps[0].target',
        code: 'invalid_union',
        message:
          'expected exactly one of role|label|testId|text|placeholder|css',
      },
    ]);
  });

  it('rejects coordinates as a locator', () => {
    expect(
      errorsOf(scenario({ action: 'click', target: { x: 10, y: 20 } })),
    ).toEqual([expect.objectContaining({ path: 'steps[0].target' })]);
  });

  it('reports a wrong field inside an otherwise recognisable locator', () => {
    expect(
      errorsOf(
        scenario({ action: 'click', target: { role: 'button', exact: 'yes' } }),
      ),
    ).toEqual([expect.objectContaining({ path: 'steps[0].target.exact' })]);
  });

  it('accepts { css } with warning css-locator at its step path', () => {
    const result = parseScenario(
      scenario(
        { action: 'navigate', path: '/' },
        { action: 'click', target: { css: '.btn-primary' } },
        {
          action: 'scroll',
          target: { testId: 'row-40' },
          within: { css: '#list' },
        },
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: [
        { path: 'steps[1].target', code: 'css-locator' },
        { path: 'steps[2].within', code: 'css-locator' },
      ],
    });
  });
});

describe('parseScenario — navigate', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<p>hi</p>',
    'ftp://example.com/',
    '/relative',
  ])('rejects url %s', (url) => {
    expect(errorsOf(scenario({ action: 'navigate', url }))).toEqual([
      expect.objectContaining({ path: 'steps[0].url' }),
    ]);
  });

  it.each([
    'https://example.com/',
    'http://localhost:3000/a?b=1',
  ])('accepts url %s', (url) => {
    expect(parseScenario(scenario({ action: 'navigate', url })).ok).toBe(true);
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    'login',
  ])('rejects path %s, which is not a same-origin path', (path) => {
    expect(errorsOf(scenario({ action: 'navigate', path }))).toEqual([
      expect.objectContaining({ path: 'steps[0].path' }),
    ]);
  });

  it('rejects both path and url', () => {
    expect(
      errorsOf(
        scenario({ action: 'navigate', path: '/', url: 'https://example.com' }),
      ),
    ).toEqual([expect.objectContaining({ path: 'steps[0]' })]);
  });
});

describe('parseScenario — scenario', () => {
  it('applies the defaults', () => {
    const result = parseScenario(
      scenario(
        { action: 'waitFor', target },
        { action: 'assertText', target, text: 'Saved' },
        { action: 'marker', title: 'Intro' },
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        browser: 'chromium',
        viewport: { width: 1920, height: 1080 },
        steps: [
          { state: 'visible', timeoutMs: 10_000 },
          { match: 'contains', timeoutMs: 10_000 },
          { kind: 'scene', timeoutMs: 10_000 },
        ],
      },
    });
  });

  it('accepts a $schema reference for editors', () => {
    const result = parseScenario({
      $schema: '../node_modules/@demoflow/core/schemas/scenario.schema.json',
      ...scenario({ action: 'navigate', path: '/' }),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects zero steps', () => {
    expect(errorsOf(scenario())).toEqual([
      expect.objectContaining({
        path: 'steps',
        message: 'expected at least one step',
      }),
    ]);
  });

  it('rejects more than 200 steps', () => {
    const steps = Array.from({ length: 201 }, () => ({
      action: 'wait',
      ms: 1,
    }));
    expect(errorsOf(scenario(...steps))).toEqual([
      expect.objectContaining({ path: 'steps' }),
    ]);
  });

  it('requires schemaVersion 1', () => {
    expect(
      errorsOf({ ...scenario({ action: 'wait', ms: 1 }), schemaVersion: 2 }),
    ).toEqual([expect.objectContaining({ path: 'schemaVersion' })]);
  });

  it('rejects a baseUrl that is not http or https', () => {
    expect(
      errorsOf({
        ...scenario({ action: 'wait', ms: 1 }),
        baseUrl: 'file:///srv/app',
      }),
    ).toEqual([expect.objectContaining({ path: 'baseUrl' })]);
  });

  it.each([
    [{ caption: 'x'.repeat(121) }, 'steps[0].caption'],
    [{ timeoutMs: 99 }, 'steps[0].timeoutMs'],
    [{ timeoutMs: 60_001 }, 'steps[0].timeoutMs'],
  ])('rejects common field %o', (field, path) => {
    expect(errorsOf(scenario({ action: 'wait', ms: 1, ...field }))).toEqual([
      expect.objectContaining({ path }),
    ]);
  });

  it.each([0, 5_001])('rejects wait ms %d', (ms) => {
    expect(errorsOf(scenario({ action: 'wait', ms }))).toEqual([
      expect.objectContaining({ path: 'steps[0].ms' }),
    ]);
  });

  it('rejects input that is not an object', () => {
    expect(errorsOf('steps: []')).toEqual([
      expect.objectContaining({ path: '' }),
    ]);
  });
});

describe('parseScenario — pacing', () => {
  const click = { action: 'click', target };

  it('leaves pacing to the defaults when the scenario sets none', () => {
    const result = parseScenario(scenario(click));
    if (!result.ok) throw new Error('expected the scenario to parse');
    expect(result.value.pacing).toBeUndefined();
    expect(resolvePacing(result.value.pacing)).toEqual({
      stepDwellMs: 1_000,
      typingDelayMs: 80,
    });
  });

  it('fills in the fields a partial pacing leaves out', () => {
    const result = parseScenario({
      ...scenario(click),
      pacing: { stepDwellMs: 0 },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        pacing: { stepDwellMs: 0, typingDelayMs: 80 },
      },
    });
  });

  it('accepts a hold (0 turns the dwell off) on any step and a typing delay on a fill', () => {
    const result = parseScenario(
      scenario(
        { ...click, hold: 0 },
        { action: 'marker', title: 'Intro', hold: 2_000 },
        { action: 'fill', target, value: 'Ada', typingDelayMs: 120 },
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        steps: [{ hold: 0 }, { hold: 2_000 }, { typingDelayMs: 120 }],
      },
    });
  });

  it('rejects out-of-range and misplaced pacing', () => {
    expect(
      errorsOf({ ...scenario(click), pacing: { stepDwellMs: -1 } }),
    ).toEqual([expect.objectContaining({ path: 'pacing.stepDwellMs' })]);
    expect(
      errorsOf({ ...scenario(click), pacing: { endHoldMs: 1_000 } }),
    ).toEqual([expect.objectContaining({ path: 'pacing.endHoldMs' })]);
    expect(
      errorsOf({ ...scenario(click), pacing: { typingDelayMs: 1.5 } }),
    ).toEqual([expect.objectContaining({ path: 'pacing.typingDelayMs' })]);
    expect(errorsOf({ ...scenario(click), pacing: { speed: 2 } })).toEqual([
      expect.objectContaining({ path: 'pacing.speed' }),
    ]);
    expect(errorsOf(scenario({ ...click, typingDelayMs: 50 }))).toEqual([
      expect.objectContaining({ path: 'steps[0].typingDelayMs' }),
    ]);
  });
});
