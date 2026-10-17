import { describe, expect, it } from 'vitest';
import { type Issue, parseScenario, type StepAction } from '../src/index.ts';

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
];

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
        'scroll',
        'assertVisible',
        'assertText',
        'screenshot',
        'marker',
        'wait',
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
