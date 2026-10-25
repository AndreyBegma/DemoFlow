import { describe, expect, it } from 'vitest';
import {
  expandScenario,
  FragmentSchema,
  type FragmentSource,
  type Issue,
  offCameraSteps,
  parseScenario,
  prefetchFragments,
  type Scenario,
} from '../src/index.ts';

const SIGN_IN = {
  schemaVersion: 1,
  description: 'Signs the demo user in.',
  params: {
    next: { description: 'Where to go once signed in.' },
    email: { default: 'DEMO_LOGIN_EMAIL' },
  },
  steps: [
    { action: 'navigate', path: '/sign-in' },
    {
      action: 'fill',
      target: { label: 'Email' },
      valueFrom: { env: 'DEMO_LOGIN_EMAIL' },
    },
    {
      action: 'fill',
      target: { label: 'Password' },
      valueFrom: { env: 'DEMO_LOGIN_PASSWORD' },
    },
    { action: 'click', target: { role: 'button', name: 'Sign in' } },
    { action: 'navigate', path: '{{params.next}}' },
  ],
};

/** Fragments by name, read as `demoflow/fragments/<name>.json`. */
function source(fragments: Record<string, unknown>): FragmentSource {
  return (name) => {
    const file = `demoflow/fragments/${name}.json`;
    return name in fragments
      ? { ok: true, file, value: fragments[name] }
      : { ok: false, file, missing: true, message: 'no such file' };
  };
}

function scenario(fields: Record<string, unknown>) {
  return { schemaVersion: 1, name: 'Demo', ...fields };
}

const visible = { action: 'click', target: { role: 'button', name: 'New' } };

function parsed(input: unknown, fragments: Record<string, unknown>): Scenario {
  const result = parseScenario(input, { fragments: source(fragments) });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function errorsOf(
  input: unknown,
  fragments: Record<string, unknown> = {},
): Issue[] {
  const result = parseScenario(input, { fragments: source(fragments) });
  if (result.ok) throw new Error('expected the scenario to be rejected');
  return result.errors;
}

const signIn = (next: unknown, extra: Record<string, unknown> = {}) => ({
  action: 'include',
  fragment: 'sign-in',
  with: { next },
  ...extra,
});

describe('include', () => {
  it('inlines the fragment, its parameters substituted', () => {
    const value = parsed(
      scenario({ steps: [signIn('/projects/demo-project'), visible] }),
      { 'sign-in': SIGN_IN },
    );
    expect(value.steps.map((step) => step.action)).toEqual([
      'navigate',
      'fill',
      'fill',
      'click',
      'navigate',
      'click',
    ]);
    expect(value.steps[4]).toMatchObject({ path: '/projects/demo-project' });
  });

  it('gives a plain scenario: it parses again with no fragments', () => {
    const value = parsed(scenario({ steps: [signIn('/projects'), visible] }), {
      'sign-in': SIGN_IN,
    });
    const again = parseScenario(value);
    expect(again).toMatchObject({ ok: true, value });
  });

  it('keeps valueFrom.env: only the variable name is in the scenario', () => {
    const value = parsed(scenario({ steps: [signIn('/projects'), visible] }), {
      'sign-in': SIGN_IN,
    });
    expect(value.steps[1]).toMatchObject({
      action: 'fill',
      target: { label: 'Email' },
      valueFrom: { env: 'DEMO_LOGIN_EMAIL' },
    });
    expect(value.steps[1]).not.toHaveProperty('value');
  });

  it('serves two scenarios from one fragment', () => {
    const fragments = { 'sign-in': SIGN_IN };
    const first = parsed(
      scenario({ steps: [signIn('/projects'), visible] }),
      fragments,
    );
    const second = parsed(
      scenario({ name: 'Other', steps: [signIn('/settings'), visible] }),
      fragments,
    );
    expect(first.steps[4]).toMatchObject({ path: '/projects' });
    expect(second.steps[4]).toMatchObject({ path: '/settings' });
  });

  it('fills a parameter the include leaves out from its default', () => {
    const fragment = {
      schemaVersion: 1,
      params: { next: { default: '/home' } },
      steps: [{ action: 'navigate', path: '{{params.next}}' }],
    };
    const value = parsed(
      scenario({ steps: [{ action: 'include', fragment: 'go' }, visible] }),
      { go: fragment },
    );
    expect(value.steps[0]).toMatchObject({ path: '/home' });
  });

  it('substitutes numbers and booleans as text', () => {
    const fragment = {
      schemaVersion: 1,
      params: { count: {}, on: {} },
      steps: [
        { action: 'marker', title: '{{params.count}} posts, {{params.on}}' },
      ],
    };
    const value = parsed(
      scenario({
        steps: [
          { action: 'include', fragment: 'n', with: { count: 3, on: true } },
        ],
      }),
      { n: fragment },
    );
    expect(value.steps[0]).toMatchObject({ title: '3 posts, true' });
  });

  it('nests: a fragment includes another, passing its own parameter on', () => {
    const open = {
      schemaVersion: 1,
      params: { project: {} },
      steps: [
        {
          action: 'include',
          fragment: 'sign-in',
          with: { next: '/projects/{{params.project}}' },
        },
        { action: 'marker', title: 'Project {{params.project}}' },
      ],
    };
    const value = parsed(
      scenario({
        steps: [
          {
            action: 'include',
            fragment: 'projects/open',
            with: { project: 'demo' },
          },
          visible,
        ],
      }),
      { 'projects/open': open, 'sign-in': SIGN_IN },
    );
    expect(value.steps).toHaveLength(7);
    expect(value.steps[4]).toMatchObject({ path: '/projects/demo' });
    expect(value.steps[5]).toMatchObject({ title: 'Project demo' });
  });

  it('keeps a literal {{ of a fragment literal through the expansion', () => {
    const fragment = {
      schemaVersion: 1,
      params: { name: {} },
      steps: [{ action: 'marker', title: '\\{{raw}} for {{params.name}}' }],
    };
    const value = parsed(
      scenario({
        steps: [
          { action: 'include', fragment: 'raw', with: { name: '\\{{x}}' } },
        ],
      }),
      { raw: fragment },
    );
    expect(expandScenario(value).steps[0]).toMatchObject({
      title: '{{raw}} for {{x}}',
    });
  });

  it('warns on a CSS locator of a fragment, naming the file and step', () => {
    const fragment = {
      schemaVersion: 1,
      steps: [{ action: 'click', target: { css: '.go' } }],
    };
    const result = parseScenario(
      scenario({ steps: [{ action: 'include', fragment: 'css' }] }),
      { fragments: source({ css: fragment }) },
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: [
        {
          path: 'steps[0]',
          code: 'css-locator',
          message: expect.stringContaining(
            'in demoflow/fragments/css.json steps[0].target:',
          ),
        },
      ],
    });
  });
});

describe('include problems', () => {
  it('names a missing fragment and the step that includes it', () => {
    expect(
      errorsOf(scenario({ steps: [visible, signIn('/projects')] })),
    ).toEqual([
      {
        path: 'steps[1].fragment',
        code: 'unknown-fragment',
        message: 'unknown fragment sign-in: no demoflow/fragments/sign-in.json',
      },
    ]);
  });

  it('names a fragment missing deeper down through the chain', () => {
    const outer = {
      schemaVersion: 1,
      steps: [visible, { action: 'include', fragment: 'gone' }],
    };
    expect(
      errorsOf(
        scenario({ steps: [{ action: 'include', fragment: 'outer' }] }),
        {
          outer,
        },
      ),
    ).toEqual([
      {
        path: 'steps[0]',
        code: 'unknown-fragment',
        message:
          'in demoflow/fragments/outer.json steps[1].fragment: unknown fragment gone: no demoflow/fragments/gone.json',
      },
    ]);
  });

  it('detects a cycle and names it', () => {
    const a = {
      schemaVersion: 1,
      steps: [{ action: 'include', fragment: 'b' }],
    };
    const b = {
      schemaVersion: 1,
      steps: [{ action: 'include', fragment: 'a' }],
    };
    expect(
      errorsOf(scenario({ steps: [{ action: 'include', fragment: 'a' }] }), {
        a,
        b,
      }),
    ).toEqual([
      {
        path: 'steps[0]',
        code: 'fragment-cycle',
        message:
          'in demoflow/fragments/a.json steps[0] → demoflow/fragments/b.json steps[0].fragment: cyclic include: a → b → a',
      },
    ]);
  });

  it('detects a fragment that includes itself', () => {
    const self = {
      schemaVersion: 1,
      steps: [{ action: 'include', fragment: 'self' }],
    };
    expect(
      errorsOf(scenario({ steps: [{ action: 'include', fragment: 'self' }] }), {
        self,
      }),
    ).toMatchObject([{ code: 'fragment-cycle' }]);
  });

  it('rejects an unknown parameter at its key', () => {
    expect(
      errorsOf(
        scenario({
          steps: [signIn('/projects'), visible].map((step, index) =>
            index === 0 ? { ...step, with: { next: '/p', nxet: '/q' } } : step,
          ),
        }),
        { 'sign-in': SIGN_IN },
      ),
    ).toEqual([
      {
        path: 'steps[0].with.nxet',
        code: 'unknown-parameter',
        message:
          'unknown parameter nxet: demoflow/fragments/sign-in.json takes next|email',
      },
    ]);
  });

  it('rejects a missing required parameter', () => {
    expect(
      errorsOf(
        scenario({ steps: [{ action: 'include', fragment: 'sign-in' }] }),
        {
          'sign-in': SIGN_IN,
        },
      ),
    ).toEqual([
      {
        path: 'steps[0].with',
        code: 'missing-parameter',
        message:
          'missing parameter next: demoflow/fragments/sign-in.json has no default for it',
      },
    ]);
  });

  it('rejects a parameter that makes a step invalid, naming file and step', () => {
    expect(
      errorsOf(scenario({ steps: [signIn('projects'), visible] }), {
        'sign-in': SIGN_IN,
      }),
    ).toEqual([
      {
        path: 'steps[0]',
        code: 'invalid_format',
        message: expect.stringMatching(
          /^in demoflow\/fragments\/sign-in\.json steps\[4\]\.path: /,
        ),
      },
    ]);
  });

  it('rejects a placeholder in a value given at the top level', () => {
    expect(
      errorsOf(scenario({ steps: [signIn('/{{params.x}}'), visible] }), {
        'sign-in': SIGN_IN,
      }),
    ).toMatchObject([
      {
        path: 'steps[0].with.next',
        code: 'template-placeholder',
        message: 'expected {{params.x}} only in a fragment',
      },
    ]);
  });

  it('rejects a fragment that uses a parameter it does not declare', () => {
    const fragment = {
      schemaVersion: 1,
      steps: [{ action: 'navigate', path: '{{params.next}}' }],
    };
    expect(
      errorsOf(scenario({ steps: [{ action: 'include', fragment: 'f' }] }), {
        f: fragment,
      }),
    ).toEqual([
      {
        path: 'steps[0].fragment',
        code: 'invalid-fragment',
        message:
          'demoflow/fragments/f.json steps[0].path: unknown parameter next: demoflow/fragments/f.json declares none',
      },
    ]);
  });

  it('rejects {{index}} and other names in a fragment', () => {
    const fragment = {
      schemaVersion: 1,
      steps: [
        { action: 'marker', title: '{{index}}' },
        { action: 'marker', title: '{{post.text}}' },
      ],
    };
    const [issue] = errorsOf(
      scenario({ steps: [{ action: 'include', fragment: 'f' }] }),
      { f: fragment },
    );
    expect(issue?.message).toContain(
      'steps[0].title: expected {{index}} only inside a repeat',
    );
    expect(issue?.message).toContain(
      'steps[1].title: expected {{params.<name>}} in a fragment, found {{post.text}}',
    );
  });

  it('rejects a repeat in a fragment', () => {
    const fragment = {
      schemaVersion: 1,
      steps: [{ action: 'repeat', each: 'posts', steps: [visible] }],
    };
    const [issue] = errorsOf(
      scenario({ steps: [{ action: 'include', fragment: 'f' }] }),
      { f: fragment },
    );
    expect(issue).toMatchObject({
      code: 'invalid-fragment',
      message: expect.stringContaining('expected no repeat in a fragment'),
    });
  });

  it('rejects an include with no fragment source', () => {
    const result = parseScenario(scenario({ steps: [signIn('/p')] }));
    expect(result).toMatchObject({
      ok: false,
      errors: [{ path: 'steps[0].fragment', code: 'no-fragments' }],
    });
  });

  it('reports an unreadable fragment file', () => {
    const result = parseScenario(scenario({ steps: [signIn('/p')] }), {
      fragments: (name) => ({
        ok: false,
        file: `demoflow/fragments/${name}.json`,
        missing: false,
        message: 'Unexpected token } in JSON',
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: 'fragment-unreadable',
          message:
            'cannot read demoflow/fragments/sign-in.json: Unexpected token } in JSON',
        },
      ],
    });
  });

  it('rejects an include inside a repeat', () => {
    const errors = errorsOf(
      scenario({
        data: { posts: [{ text: 'a' }] },
        steps: [{ action: 'repeat', each: 'posts', steps: [signIn('/p')] }],
      }),
      { 'sign-in': SIGN_IN },
    );
    expect(errors[0]?.path).toBe('steps[0].steps[0].action');
  });

  it('rejects includes nested too deep', () => {
    const fragments: Record<string, unknown> = {};
    for (let level = 0; level < 10; level++) {
      fragments[`f${level}`] = {
        schemaVersion: 1,
        steps: [{ action: 'include', fragment: `f${level + 1}` }],
      };
    }
    fragments.f10 = { schemaVersion: 1, steps: [visible] };
    const errors = errorsOf(
      scenario({ steps: [{ action: 'include', fragment: 'f0' }] }),
      fragments,
    );
    expect(errors).toMatchObject([
      { path: 'steps[0]', code: 'fragment-depth' },
    ]);
  });

  it('rejects a section that grows past 200 steps once inlined', () => {
    const many = {
      schemaVersion: 1,
      steps: Array.from({ length: 150 }, () => visible),
    };
    const errors = errorsOf(
      scenario({
        steps: [
          { action: 'include', fragment: 'many' },
          { action: 'include', fragment: 'many' },
        ],
      }),
      { many },
    );
    expect(errors).toMatchObject([
      { path: 'steps[1]', code: 'too-many-steps' },
    ]);
  });
});

describe('off camera', () => {
  it('hides every step of an include with record: false', () => {
    const value = parsed(
      scenario({ steps: [signIn('/projects', { record: false }), visible] }),
      { 'sign-in': SIGN_IN },
    );
    const { steps } = expandScenario(value);
    expect(offCameraSteps(steps)).toBe(5);
    expect(steps.slice(0, 5).every((step) => step.record === false)).toBe(true);
    expect(steps[5]).not.toHaveProperty('record');
  });

  it('runs setup first, off camera', () => {
    const value = parsed(
      scenario({ setup: [signIn('/projects')], steps: [visible] }),
      { 'sign-in': SIGN_IN },
    );
    const { steps } = expandScenario(value);
    expect(steps).toHaveLength(6);
    expect(offCameraSteps(steps)).toBe(5);
    expect(steps[5]).toMatchObject(visible);
  });

  it('accepts a plain step with record: false before the recorded ones', () => {
    const value = parsed(
      scenario({
        steps: [{ action: 'navigate', path: '/', record: false }, visible],
      }),
      {},
    );
    expect(offCameraSteps(expandScenario(value).steps)).toBe(1);
  });

  it('hides every iteration of a repeat with record: false', () => {
    const value = parsed(
      scenario({
        data: { posts: [{ text: 'a' }, { text: 'b' }] },
        steps: [
          {
            action: 'repeat',
            each: 'posts',
            record: false,
            caption: 'Seed',
            steps: [{ action: 'marker', title: '{{item.text}}' }],
          },
          visible,
        ],
      }),
      {},
    );
    expect(offCameraSteps(expandScenario(value).steps)).toBe(3);
  });

  it('rejects an off-camera step after a recorded one', () => {
    expect(
      errorsOf(
        scenario({
          steps: [visible, { action: 'navigate', path: '/', record: false }],
        }),
      ),
    ).toEqual([
      {
        path: 'steps[1].record',
        code: 'off-camera-after-recorded',
        message:
          'expected record: false only before the first recorded step: off-camera steps run before the recording starts',
      },
    ]);
  });

  it('rejects an off-camera include after a recorded step', () => {
    expect(
      errorsOf(
        scenario({ steps: [visible, signIn('/p', { record: false })] }),
        { 'sign-in': SIGN_IN },
      ),
    ).toMatchObject([
      {
        path: 'steps[1]',
        code: 'off-camera-after-recorded',
        message: expect.stringContaining(
          '(in demoflow/fragments/sign-in.json steps[0])',
        ),
      },
    ]);
  });

  it('rejects a scenario with nothing recorded', () => {
    expect(
      errorsOf(
        scenario({ setup: [visible], steps: [{ ...visible, record: false }] }),
      ),
    ).toEqual([
      {
        path: 'steps',
        code: 'nothing-recorded',
        message: 'expected at least one recorded step',
      },
    ]);
  });

  it('rejects record: true in setup', () => {
    expect(
      errorsOf(
        scenario({ setup: [{ ...visible, record: true }], steps: [visible] }),
      ),
    ).toMatchObject([{ path: 'setup[0].record', code: 'record-in-setup' }]);
  });

  it('rejects record on a step inside a repeat', () => {
    expect(
      errorsOf(
        scenario({
          data: { posts: [{ text: 'a' }] },
          steps: [
            {
              action: 'repeat',
              each: 'posts',
              steps: [{ ...visible, record: false }],
            },
          ],
        }),
      ),
    ).toMatchObject([
      { path: 'steps[0].steps[0].record', code: 'record-in-repeat' },
    ]);
  });

  it('rejects a repeat in setup', () => {
    expect(
      errorsOf(
        scenario({
          data: { posts: [{ text: 'a' }] },
          setup: [{ action: 'repeat', each: 'posts', steps: [visible] }],
          steps: [visible],
        }),
      ),
    ).toMatchObject([
      { path: 'setup[0].action', message: 'expected no repeat in setup' },
    ]);
  });

  it('runs an old scenario unchanged', () => {
    const value = parsed(scenario({ steps: [visible] }), {});
    expect(value).not.toHaveProperty('setup');
    expect(offCameraSteps(expandScenario(value).steps)).toBe(0);
  });
});

describe('FragmentSchema', () => {
  it('accepts the sign-in fragment', () => {
    expect(FragmentSchema.safeParse(SIGN_IN).success).toBe(true);
  });

  it('rejects a fragment with no steps', () => {
    expect(
      FragmentSchema.safeParse({ schemaVersion: 1, steps: [] }).success,
    ).toBe(false);
  });
});

describe('prefetchFragments', () => {
  const nested = {
    schemaVersion: 1,
    steps: [{ action: 'include', fragment: 'sign-in', with: { next: '/' } }],
  };

  it('reads every fragment once, nested ones too, and serves them', async () => {
    const read: string[] = [];
    const fragments = source({ 'sign-in': SIGN_IN, 'sign-in-home': nested });
    const prefetched = await prefetchFragments(
      scenario({
        setup: [{ action: 'include', fragment: 'sign-in-home' }],
        steps: [signIn('/a'), visible, { action: 'include', fragment: '../x' }],
      }),
      async (name) => {
        read.push(name);
        return fragments(name);
      },
    );
    expect(read).toEqual(['sign-in-home', 'sign-in']);
    const result = parseScenario(
      scenario({
        setup: [{ action: 'include', fragment: 'sign-in-home' }],
        steps: [signIn('/a'), visible],
      }),
      { fragments: prefetched },
    );
    expect(result.ok).toBe(true);
  });

  it('stops reading a cycle', async () => {
    const loop = {
      schemaVersion: 1,
      steps: [{ action: 'include', fragment: 'loop' }],
    };
    const read: string[] = [];
    const prefetched = await prefetchFragments(
      scenario({ steps: [{ action: 'include', fragment: 'loop' }] }),
      async (name) => {
        read.push(name);
        return source({ loop })(name);
      },
    );
    expect(read).toEqual(['loop']);
    expect(prefetched('other')).toMatchObject({ ok: false, missing: false });
  });

  it('reads nothing from a scenario that is not an object', async () => {
    const prefetched = await prefetchFragments('nope', async () => {
      throw new Error('expected no read');
    });
    expect(prefetched('a')).toMatchObject({ ok: false });
  });
});
