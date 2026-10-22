import { describe, expect, it } from 'vitest';
import {
  expandScenario,
  type Issue,
  parseScenario,
  RunResultSchema,
  type Scenario,
  TimelineEventSchema,
} from '../src/index.ts';

const POSTS = [
  { text: 'First post' },
  { text: 'Second post' },
  { text: 'Third post' },
  { text: 'Fourth post' },
  { text: 'Fifth post' },
];

function scenario(steps: unknown[], data?: unknown) {
  return {
    schemaVersion: 1,
    name: 'Demo',
    ...(data === undefined ? {} : { data }),
    steps,
  };
}

function parsed(input: unknown): Scenario {
  const result = parseScenario(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function errorsOf(input: unknown): Issue[] {
  const result = parseScenario(input);
  if (result.ok) throw new Error('expected the scenario to be rejected');
  return result.errors;
}

const compose = { label: 'New post' };
const postRepeat = {
  action: 'repeat',
  each: 'posts',
  as: 'post',
  steps: [
    { action: 'click', target: { role: 'button', name: 'Compose' } },
    { action: 'fill', target: compose, value: '{{post.text}}' },
    { action: 'click', target: { role: 'button', name: 'Post' } },
  ],
};

describe('expandScenario', () => {
  it('runs the steps of a repeat once per item, with the item substituted', () => {
    const { steps } = expandScenario(
      parsed(scenario([postRepeat], { posts: POSTS })),
    );
    expect(steps).toHaveLength(15);
    expect(
      steps.filter((step) => step.action === 'fill').map((step) => step.value),
    ).toEqual(POSTS.map((post) => post.text));
    expect(steps.map((step) => step.origin)).toEqual(
      [0, 1, 2, 3, 4].flatMap((iteration) =>
        Array.from({ length: 3 }, () => ({ repeatIndex: 0, iteration })),
      ),
    );
  });

  it('leaves steps outside a repeat as they are, without an origin', () => {
    const { steps } = expandScenario(
      parsed(
        scenario(
          [
            { action: 'navigate', path: '/feed' },
            postRepeat,
            { action: 'assertVisible', target: { text: 'Fifth post' } },
          ],
          { posts: POSTS.slice(0, 2) },
        ),
      ),
    );
    expect(steps).toHaveLength(8);
    expect(steps[0]).toEqual({
      action: 'navigate',
      path: '/feed',
      timeoutMs: 10_000,
    });
    expect(steps[1].origin).toEqual({ repeatIndex: 1, iteration: 0 });
    expect(steps[7].origin).toBeUndefined();
  });

  it('substitutes every string field, {{index}} 1-based, numbers and booleans as text', () => {
    const { steps } = expandScenario(
      parsed(
        scenario(
          [
            {
              action: 'repeat',
              each: 'rows',
              steps: [
                {
                  action: 'navigate',
                  url: '{{item.url}}',
                  caption: 'Row {{ index }}: {{item.name}}',
                },
                {
                  action: 'assertText',
                  target: { role: 'cell', name: '{{item.name}}' },
                  text: '{{item.count}} / {{item.active}}',
                  match: '{{item.match}}',
                },
                { action: 'marker', title: '{{item.name}}', kind: 'caption' },
              ],
            },
          ],
          {
            rows: [
              {
                url: 'https://example.test/a',
                name: 'Ada',
                count: 3,
                active: true,
                match: 'exact',
              },
            ],
          },
        ),
      ),
    );
    expect(steps).toEqual([
      {
        action: 'navigate',
        url: 'https://example.test/a',
        caption: 'Row 1: Ada',
        timeoutMs: 10_000,
        origin: { repeatIndex: 0, iteration: 0 },
      },
      {
        action: 'assertText',
        target: { role: 'cell', name: 'Ada' },
        text: '3 / true',
        match: 'exact',
        timeoutMs: 10_000,
        origin: { repeatIndex: 0, iteration: 0 },
      },
      {
        action: 'marker',
        title: 'Ada',
        kind: 'caption',
        timeoutMs: 10_000,
        origin: { repeatIndex: 0, iteration: 0 },
      },
    ]);
  });

  it('reads \\{{ as a literal {{, inside and outside a repeat', () => {
    const { steps } = expandScenario(
      parsed(
        scenario(
          [
            { action: 'fill', target: compose, value: 'a \\{{b}} c' },
            {
              action: 'repeat',
              each: 'posts',
              steps: [
                {
                  action: 'fill',
                  target: compose,
                  value: '\\{{item.text}} = {{item.text}}',
                },
              ],
            },
          ],
          { posts: [{ text: 'x' }] },
        ),
      ),
    );
    expect(steps.map((step) => step.action === 'fill' && step.value)).toEqual([
      'a {{b}} c',
      '{{item.text}} = x',
    ]);
  });

  it('shows the caption of a repeat once, as a caption marker before the first iteration', () => {
    const { steps } = expandScenario(
      parsed(
        scenario([{ ...postRepeat, caption: 'Five posts' }], { posts: POSTS }),
      ),
    );
    expect(steps).toHaveLength(16);
    expect(steps[0]).toEqual({
      action: 'marker',
      title: 'Five posts',
      kind: 'caption',
      timeoutMs: 10_000,
      origin: { repeatIndex: 0, iteration: 0 },
    });
    expect(steps.filter((step) => step.action === 'marker')).toHaveLength(1);
  });

  it('copies a zoom inside a repeat to every iteration (#163)', () => {
    const { steps } = expandScenario(
      parsed(
        scenario(
          [
            {
              action: 'repeat',
              each: 'posts',
              steps: [{ action: 'click', target: compose, zoom: 2 }],
            },
          ],
          { posts: POSTS },
        ),
      ),
    );
    expect(steps.map((step) => 'zoom' in step && step.zoom)).toEqual([
      2, 2, 2, 2, 2,
    ]);
  });

  it('defaults the item name to item', () => {
    const value = parsed(
      scenario(
        [
          {
            action: 'repeat',
            each: 'posts',
            steps: [
              { action: 'fill', target: compose, value: '{{item.text}}' },
            ],
          },
        ],
        { posts: POSTS },
      ),
    );
    expect(value.steps[0]).toMatchObject({ as: 'item' });
  });

  it('is pure: the scenario is left unchanged and expands the same twice', () => {
    const value = parsed(scenario([postRepeat], { posts: POSTS }));
    const copy = structuredClone(value);
    const first = expandScenario(value);
    expect(expandScenario(value)).toEqual(first);
    expect(value).toEqual(copy);
  });

  it('throws on a scenario parseScenario would reject', () => {
    const value = parsed(scenario([postRepeat], { posts: POSTS }));
    expect(() => expandScenario({ ...value, data: {} })).toThrow(
      /steps\[0\]\.each: unknown data list posts/,
    );
  });
});

describe('parseScenario: data and repeat', () => {
  it('rejects a field missing in an item, naming the step path and the item', () => {
    expect(
      errorsOf(
        scenario([postRepeat], {
          posts: [{ text: 'a' }, { text: 'b' }, { title: 'c' }],
        }),
      ),
    ).toEqual([
      {
        path: 'steps[0].steps[1].value',
        code: 'template-placeholder',
        message: 'unknown field post.text: missing in data.posts[2]',
      },
    ]);
  });

  it('rejects a name the repeat does not give its item', () => {
    const repeat = {
      ...postRepeat,
      steps: [{ action: 'fill', target: compose, value: '{{item.text}}' }],
    };
    expect(errorsOf(scenario([repeat], { posts: POSTS }))).toEqual([
      {
        path: 'steps[0].steps[0].value',
        code: 'template-placeholder',
        message: 'unknown name item: this repeat calls its item post',
      },
    ]);
  });

  it('rejects an unknown data list', () => {
    expect(errorsOf(scenario([postRepeat], { users: POSTS }))).toEqual([
      {
        path: 'steps[0].each',
        code: 'unknown-data-list',
        message: 'unknown data list posts: expected one of users',
      },
    ]);
    expect(errorsOf(scenario([postRepeat]))[0].message).toBe(
      'unknown data list posts: the scenario has no data',
    );
  });

  it('rejects {{…}} outside a repeat', () => {
    expect(
      errorsOf(
        scenario([
          { action: 'navigate', path: '/' },
          { action: 'fill', target: compose, value: 'Hi {{post.text}}' },
          { action: 'marker', title: 'Step {{index}}' },
        ]),
      ),
    ).toEqual([
      {
        path: 'steps[1].value',
        code: 'template-placeholder',
        message: 'expected {{post.text}} only inside a repeat',
      },
      {
        path: 'steps[2].title',
        code: 'template-placeholder',
        message: 'expected {{index}} only inside a repeat',
      },
    ]);
  });

  it('rejects {{…}} in the caption of the repeat itself', () => {
    expect(
      errorsOf(
        scenario([{ ...postRepeat, caption: 'Post {{post.text}}' }], {
          posts: POSTS,
        }),
      ),
    ).toEqual([
      {
        path: 'steps[0].caption',
        code: 'template-placeholder',
        message:
          'expected no {{post.text}} in the caption of a repeat: it is shown once, before the first iteration',
      },
    ]);
  });

  it('rejects a malformed or unclosed placeholder', () => {
    const repeat = {
      ...postRepeat,
      steps: [
        { action: 'fill', target: compose, value: '{{post}}' },
        { action: 'fill', target: compose, value: '{{post.text' },
      ],
    };
    expect(errorsOf(scenario([repeat], { posts: POSTS }))).toEqual([
      {
        path: 'steps[0].steps[0].value',
        code: 'template-syntax',
        message: 'expected {{<name>.<field>}} or {{index}}, found {{post}}',
      },
      {
        path: 'steps[0].steps[1].value',
        code: 'template-syntax',
        message: 'expected }} to close {{ (write \\{{ for a literal {{)',
      },
    ]);
  });

  it('rejects a nested repeat', () => {
    const nested = {
      ...postRepeat,
      steps: [{ action: 'repeat', each: 'posts', steps: postRepeat.steps }],
    };
    expect(errorsOf(scenario([nested], { posts: POSTS }))).toEqual([
      expect.objectContaining({
        path: 'steps[0].steps[0].action',
        message: 'expected no repeat inside a repeat: loops are one level deep',
      }),
    ]);
  });

  it('rejects more than 100 items, and an empty list', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ text: `${i}` }));
    expect(errorsOf(scenario([postRepeat], { posts: many }))).toEqual([
      expect.objectContaining({
        path: 'data.posts',
        message: 'expected at most 100 items',
      }),
    ]);
    expect(errorsOf(scenario([postRepeat], { posts: [] }))).toEqual([
      expect.objectContaining({
        path: 'data.posts',
        message: 'expected at least one item',
      }),
    ]);
  });

  it('rejects substitution into valueFrom', () => {
    const repeat = {
      ...postRepeat,
      steps: [
        { action: 'fill', target: compose, valueFrom: { env: '{{post.env}}' } },
      ],
    };
    expect(errorsOf(scenario([repeat], { posts: POSTS }))).toEqual([
      {
        path: 'steps[0].steps[0].valueFrom.env',
        code: 'custom',
        message:
          'expected no {{…}} in valueFrom: secrets come from the environment, never from data',
      },
    ]);
  });

  it('checks formats on the expanded step, naming the iteration', () => {
    const repeat = {
      action: 'repeat',
      each: 'pages',
      steps: [
        { action: 'navigate', url: '{{item.url}}' },
        { action: 'click', target: { text: '{{item.label}}' } },
      ],
    };
    expect(
      errorsOf(
        scenario([repeat], {
          pages: [
            { url: 'https://example.test/a', label: 'A' },
            { url: 'ftp://example.test/b', label: '' },
            { url: 'nope', label: 'C' },
          ],
        }),
      ),
    ).toEqual([
      {
        path: 'steps[0].steps[0].url',
        code: 'invalid_format',
        message: 'expected an absolute http or https URL (iteration 2)',
      },
      expect.objectContaining({
        path: 'steps[0].steps[1].target.text',
        message: expect.stringMatching(/\(iteration 2\)$/),
      }),
    ]);
  });

  it('checks the template shape before substitution: unknown fields, formats without a placeholder', () => {
    const repeat = {
      ...postRepeat,
      steps: [
        { action: 'click', target: compose, colour: 'red' },
        { action: 'navigate', path: 'no-slash' },
        { action: 'press', key: '{{post.key}}' },
      ],
    };
    expect(errorsOf(scenario([repeat], { posts: [{ key: 'Enter' }] }))).toEqual(
      [
        expect.objectContaining({
          path: 'steps[0].steps[0].colour',
          message: 'unknown field',
        }),
        expect.objectContaining({
          path: 'steps[0].steps[1].path',
          message: 'expected a path starting with a single /',
        }),
      ],
    );
  });

  it('rejects data names that are not identifiers, and timeoutMs on a repeat', () => {
    expect(
      errorsOf(
        scenario([{ ...postRepeat, timeoutMs: 1_000 }], {
          'my posts': POSTS,
        }),
      ).map((issue) => issue.path),
    ).toEqual(
      expect.arrayContaining(['data["my posts"]', 'steps[0].timeoutMs']),
    );
    expect(
      errorsOf(scenario([{ ...postRepeat, as: 'index' }], { posts: POSTS }))[0]
        .path,
    ).toBe('steps[0].as');
  });

  it('warns on a css locator inside a repeat at its template path', () => {
    const result = parseScenario(
      scenario(
        [
          {
            ...postRepeat,
            steps: [{ action: 'click', target: { css: '.post' } }],
          },
        ],
        { posts: POSTS },
      ),
    );
    expect(result.ok && result.warnings.map((w) => w.path)).toEqual([
      'steps[0].steps[0].target',
    ]);
  });
});

describe('origin in the timeline and the run result', () => {
  const event = { stepIndex: 4, action: 'click', startMs: 0, endMs: 10 };

  it('a timeline event may carry the origin, and older events stay valid', () => {
    expect(TimelineEventSchema.safeParse(event).success).toBe(true);
    expect(
      TimelineEventSchema.safeParse({
        ...event,
        origin: { repeatIndex: 1, iteration: 2 },
      }).success,
    ).toBe(true);
    expect(
      TimelineEventSchema.safeParse({
        ...event,
        origin: { repeatIndex: 1, iteration: -1 },
      }).success,
    ).toBe(false);
  });

  it('a stage error may carry the origin of the failed step', () => {
    const skipped = { status: 'skipped' } as const;
    const result = {
      schemaVersion: 1,
      runId: 'r',
      scenarioId: 'demoflow/a.demo.json',
      scenarioName: 'A',
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:00:01.000Z',
      status: 'failed',
      stages: {
        readiness: { status: 'passed' },
        execution: {
          status: 'failed',
          error: {
            message: 'no element',
            stepIndex: 4,
            origin: { repeatIndex: 1, iteration: 2 },
          },
        },
        verification: skipped,
        recording: { status: 'passed' },
        rendering: skipped,
        storage: skipped,
      },
      renders: [],
      warnings: [],
    };
    expect(RunResultSchema.safeParse(result).success).toBe(true);
  });
});
