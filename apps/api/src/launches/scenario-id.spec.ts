import { isScenarioId } from './scenario-id';

describe('isScenarioId', () => {
  it.each([
    'demoflow/checkout.demo.json',
    'demoflow/shop/cart/add.demo.json',
    'demoflow/a b.demo.json',
    `demoflow/${'a'.repeat(255 - 'demoflow/.demo.json'.length)}.demo.json`,
  ])('accepts %j', (id) => {
    expect(isScenarioId(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['a parent segment', '../x.demo.json'],
    ['a parent segment inside', 'demoflow/../x.demo.json'],
    ['a dot segment', 'demoflow/./x.demo.json'],
    ['an empty segment', 'demoflow//x.demo.json'],
    ['a backslash', 'demoflow/a\\b.demo.json'],
    ['a colon', 'demoflow/c:x.demo.json'],
    ['a control character', 'demoflow/a\u0001.demo.json'],
    ['DEL', 'demoflow/a\u007f.demo.json'],
    ['the wrong suffix', 'demoflow/x.json'],
    ['an absolute path', '/abs/demoflow/x.demo.json'],
    ['another root', 'demos/x.demo.json'],
    ['only the prefix and suffix', 'demoflow/.demo.json/..'],
    [
      '256 characters',
      `demoflow/${'a'.repeat(256 - 'demoflow/.demo.json'.length)}.demo.json`,
    ],
  ])('refuses %s', (_label, id) => {
    expect(isScenarioId(id)).toBe(false);
  });
});
