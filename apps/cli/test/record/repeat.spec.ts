import { expandScenario, parseScenario } from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import {
  defaultFieldName,
  type RepeatRequest,
  repeatableValue,
  usedData,
  wrapRepeat,
} from '../../src/record/repeat.ts';
import { buildScenario, type RecordedStep } from '../../src/record/steps.ts';

const viewport = { width: 1280, height: 720 };
const recorded: RecordedStep[] = [
  { step: { action: 'navigate', path: '/' } },
  { step: { action: 'click', target: { role: 'button', name: 'New post' } } },
  {
    step: { action: 'fill', target: { label: 'Title' }, value: 'First post' },
  },
  {
    step: { action: 'fill', target: { label: 'Body' }, value: 'Hello there' },
  },
  {
    step: {
      action: 'fill',
      target: { label: 'Password' },
      valueFrom: { env: 'DEMO_PASSWORD' },
    },
  },
  { step: { action: 'click', target: { role: 'button', name: 'Post' } } },
];

const request: RepeatRequest = {
  from: 1,
  to: 5,
  list: 'posts',
  fields: [
    { name: 'text', lines: ['First post', 'Second', 'Third'] },
    { name: 'text2', lines: ['Hello there', 'More', 'Even more'] },
  ],
};

describe('wrapRepeat', () => {
  it('replaces typed values with placeholders and writes the lines as items', () => {
    const wrapped = wrapRepeat(recorded, {}, request);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    expect(wrapped.steps.map(({ step }) => step)).toEqual([
      { action: 'navigate', path: '/' },
      {
        action: 'repeat',
        each: 'posts',
        steps: [
          { action: 'click', target: { role: 'button', name: 'New post' } },
          {
            action: 'fill',
            target: { label: 'Title' },
            value: '{{item.text}}',
          },
          {
            action: 'fill',
            target: { label: 'Body' },
            value: '{{item.text2}}',
          },
          // A secret is left as recorded: it never comes from data.
          {
            action: 'fill',
            target: { label: 'Password' },
            valueFrom: { env: 'DEMO_PASSWORD' },
          },
          { action: 'click', target: { role: 'button', name: 'Post' } },
        ],
      },
    ]);
    expect(wrapped.data).toEqual({
      posts: [
        { text: 'First post', text2: 'Hello there' },
        { text: 'Second', text2: 'More' },
        { text: 'Third', text2: 'Even more' },
      ],
    });
  });

  it('writes a scenario that validates and expands to one run per line', () => {
    const wrapped = wrapRepeat(recorded, {}, request);
    if (!wrapped.ok) throw new Error(wrapped.message);

    const scenario = buildScenario(
      'posts',
      viewport,
      wrapped.steps,
      wrapped.data,
    );
    const parsed = parseScenario(scenario);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { steps } = expandScenario(parsed.value);
    expect(steps).toHaveLength(1 + 3 * 5);
    expect(steps[2]).toMatchObject({ action: 'fill', value: 'First post' });
    expect(steps[7]).toMatchObject({ action: 'fill', value: 'Second' });
    expect(steps[12]).toMatchObject({ action: 'fill', value: 'Third' });
  });

  it('keeps a recorded {{ in other strings literal', () => {
    const steps: RecordedStep[] = [
      { step: { action: 'marker', title: 'Use {{braces}}' } },
      { step: { action: 'fill', target: { label: 'Title' }, value: 'x' } },
    ];
    const wrapped = wrapRepeat(
      steps,
      {},
      {
        from: 0,
        to: 1,
        list: 'items',
        fields: [{ name: 'text', lines: ['a', 'b'] }],
      },
    );
    if (!wrapped.ok) throw new Error(wrapped.message);
    const parsed = parseScenario(
      buildScenario('braces', viewport, wrapped.steps, wrapped.data),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(expandScenario(parsed.value).steps[0]).toMatchObject({
      title: 'Use {{braces}}',
    });
  });

  it.each([
    ['a selection past the end', { ...request, to: 9 }, /select a run/],
    [
      'a list name that is not a key',
      { ...request, list: '1 posts' },
      /list name/,
    ],
    [
      'a duplicate field name',
      {
        ...request,
        fields: [
          { name: 'a', lines: ['1'] },
          { name: 'a', lines: ['2'] },
        ],
      },
      /used twice/,
    ],
    [
      'fields of different lengths',
      {
        ...request,
        fields: [
          { name: 'a', lines: ['1', '2'] },
          { name: 'b', lines: ['1'] },
        ],
      },
      /same number of lines/,
    ],
    [
      'the wrong number of fields',
      { ...request, fields: [{ name: 'a', lines: ['1'] }] },
      /expected values for 2 fills/,
    ],
    [
      'more than 100 items',
      {
        ...request,
        fields: [
          { name: 'a', lines: Array.from({ length: 101 }, () => 'x') },
          { name: 'b', lines: Array.from({ length: 101 }, () => 'x') },
        ],
      },
      /at most 100/,
    ],
    ['no typed text', { ...request, from: 0, to: 1 }, /no typed text/],
  ])('refuses %s', (_, bad, message) => {
    const wrapped = wrapRepeat(recorded, {}, bad);
    expect(wrapped.ok).toBe(false);
    if (!wrapped.ok) expect(wrapped.message).toMatch(message);
  });

  it('refuses a name already taken and a selection holding a repeat', () => {
    const first = wrapRepeat(recorded, {}, request);
    if (!first.ok) throw new Error(first.message);
    expect(wrapRepeat(recorded, first.data, request)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/already a list/),
    });
    expect(
      wrapRepeat(first.steps, {}, { ...request, from: 0, to: 1 }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/one level/) });
  });
});

describe('repeat helpers', () => {
  it('leaves secrets and multi-line values out of the fields', () => {
    expect(
      repeatableValue({ action: 'fill', target: { label: 'A' }, value: 'x' }),
    ).toBe('x');
    expect(
      repeatableValue({
        action: 'fill',
        target: { label: 'A' },
        valueFrom: { env: 'PW' },
      }),
    ).toBeUndefined();
    expect(
      repeatableValue({
        action: 'fill',
        target: { label: 'A' },
        value: 'a\nb',
      }),
    ).toBeUndefined();
  });

  it('names fields text, text2, …', () => {
    expect([0, 1, 2].map(defaultFieldName)).toEqual(['text', 'text2', 'text3']);
  });

  it('drops the list of a repeat that was deleted', () => {
    const wrapped = wrapRepeat(recorded, {}, request);
    if (!wrapped.ok) throw new Error(wrapped.message);
    expect(usedData(wrapped.steps, wrapped.data)).toHaveProperty('posts');
    expect(usedData([], wrapped.data)).toEqual({});
    expect(
      buildScenario(
        'none',
        viewport,
        [{ step: { action: 'navigate', path: '/' } }],
        wrapped.data,
      ),
    ).not.toHaveProperty('data');
  });
});
