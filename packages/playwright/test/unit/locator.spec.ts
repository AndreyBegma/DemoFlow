import { describe, expect, it } from 'vitest';
import { derivedReason, describeLocator } from '../../src/locator.ts';

describe('describeLocator: the rows of Decision 3', () => {
  it.each([
    ['getByRole', ['button'], { role: 'button' }],
    ['getByRole', ['button', { name: 'Sign in' }], { role: 'button', name: 'Sign in' }],
    [
      'getByRole',
      ['button', { name: 'Create', exact: true }],
      { role: 'button', name: 'Create', exact: true },
    ],
    ['getByRole', ['button', { exact: false }], { role: 'button' }],
    ['getByLabel', ['Email'], { label: 'Email' }],
    ['getByLabel', ['Email', { exact: true }], { label: 'Email', exact: true }],
    ['getByText', ['Report ready'], { text: 'Report ready' }],
    ['getByText', ['Ready', { exact: true }], { text: 'Ready', exact: true }],
    ['getByPlaceholder', ['Search'], { placeholder: 'Search' }],
    ['getByPlaceholder', ['Search', { exact: true }], { placeholder: 'Search', exact: true }],
    ['getByTestId', ['hover-card'], { testId: 'hover-card' }],
    ['locator', ['tbody'], { css: 'tbody' }],
    ['locator', ['form > button'], { css: 'form > button' }],
  ] as const)('%s(%j) is %j', (factory, args, locator) => {
    expect(describeLocator(factory, args)).toEqual({ locator });
  });
});

describe('describeLocator: no scenario form (Decision 4)', () => {
  it.each([
    ['getByRole', [/button/], /regular expression as the role/],
    ['getByRole', ['button', { name: /Sign/ }], /regular expression as the name/],
    ['getByRole', ['button', { checked: true }], /option checked/],
    ['getByRole', ['heading', { level: 1 }], /option level/],
    ['getByRole', ['button', { includeHidden: true }], /option includeHidden/],
    ['getByLabel', [/Email/], /regular expression as the label/],
    ['getByText', [/ready/i], /regular expression as the text/],
    ['getByPlaceholder', [/Search/], /regular expression as the placeholder/],
    ['getByTestId', [/card/], /regular expression as the test id/],
    ['getByText', ['x', { exact: true, foo: 1 }], /option foo/],
    ['locator', ['tbody', { hasText: 'Ada' }], /locator\(\) with options/],
    ['locator', ['form >> button'], /chained selector/],
    ['locator', ['text=Sign in'], /selector engine \(text=\)/],
    ['locator', ['xpath=//button'], /selector engine \(xpath=\)/],
    ['locator', ['internal:role=button'], /selector engine \(internal:\)/],
    ['locator', ['//button'], /selector engine \(\/\/\)/],
    ['locator', [''], /empty selector/],
  ] as const)('%s(%o)', (factory, args, reason) => {
    const described = describeLocator(factory, args);
    expect(described).toEqual({ reason: expect.stringMatching(reason) });
  });

  it.each([
    'first',
    'last',
    'nth',
    'filter',
    'and',
    'or',
    'locator',
    'getByRole',
    'frameLocator',
  ])('a locator built with %s() names the method', (method) => {
    expect(derivedReason(method)).toBe(
      `a locator built with ${method}() has no scenario form`,
    );
  });
});
