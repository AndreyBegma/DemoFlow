import { describe, expect, it } from 'vitest';
import {
  actionOptionsProblem,
  assertionStep,
  navigateStep,
  pressStep,
  screenshotStep,
  scrollStep,
  selectStep,
  waitForStep,
  wheelStep,
} from '../../src/steps.ts';

const target = { label: 'Plan' };
const BASE = 'http://127.0.0.1:3680';

describe('navigateStep', () => {
  it('records a path under baseURL', () => {
    expect(navigateStep('/login', BASE)).toEqual({
      step: { action: 'navigate', path: '/login' },
    });
    expect(navigateStep(`${BASE}/customers?q=a#x`, BASE)).toEqual({
      step: { action: 'navigate', path: '/customers?q=a#x' },
    });
  });

  it('keeps a baseURL path prefix in the path', () => {
    expect(navigateStep('login', 'http://h/app/')).toEqual({
      step: { action: 'navigate', path: '/app/login' },
    });
  });

  it('records a URL outside baseURL, or with no baseURL', () => {
    expect(navigateStep('https://example.com/a', BASE)).toEqual({
      step: { action: 'navigate', url: 'https://example.com/a' },
    });
    expect(navigateStep('http://h/other', 'http://h/app/')).toEqual({
      step: { action: 'navigate', url: 'http://h/other' },
    });
    expect(navigateStep('https://example.com/', undefined)).toEqual({
      step: { action: 'navigate', url: 'https://example.com/' },
    });
  });

  it('refuses what a scenario cannot navigate to', () => {
    expect(navigateStep('/login', undefined)).toHaveProperty('reason');
    expect(navigateStep('about:blank', BASE)).toEqual({
      reason: expect.stringContaining('about: URL'),
    });
  });
});

describe('selectStep', () => {
  it('records one string, or an array of one', () => {
    for (const option of ['Pro', ['Pro']]) {
      expect(selectStep(target, option)).toEqual({
        step: { action: 'select', target, option: 'Pro' },
      });
    }
  });

  it('refuses several options or a non-string one', () => {
    expect(selectStep(target, ['Pro', 'Team'])).toEqual({
      reason: '2 options; a scenario selects one',
    });
    expect(selectStep(target, { label: 'Pro' })).toEqual({
      reason: 'an option that is not a string',
    });
  });
});

describe('pressStep', () => {
  it('records a key pressKeyProblem accepts', () => {
    expect(pressStep(target, 'Enter')).toEqual({
      step: { action: 'press', key: 'Enter', target },
    });
    expect(pressStep(target, 'Control+a')).toHaveProperty('step');
  });

  it('refuses a key pressKeyProblem refuses', () => {
    expect(pressStep(target, 'a')).toEqual({
      reason: expect.stringContaining('the key "a"'),
    });
  });
});

describe('waitForStep', () => {
  it('records the state, visible by default', () => {
    expect(waitForStep(target, undefined)).toEqual({
      step: { action: 'waitFor', target, state: 'visible' },
    });
    expect(waitForStep(target, { state: 'hidden' })).toEqual({
      step: { action: 'waitFor', target, state: 'hidden' },
    });
  });

  it('keeps a timeout only inside the schema bounds', () => {
    expect(waitForStep(target, { timeout: 10_000 })).toEqual({
      step: { action: 'waitFor', target, state: 'visible', timeoutMs: 10_000 },
    });
    for (const timeout of [0, 50, 60_001, 1.5]) {
      expect(waitForStep(target, { timeout })).toEqual({
        step: { action: 'waitFor', target, state: 'visible' },
      });
    }
  });

  it('refuses attached and detached', () => {
    expect(waitForStep(target, { state: 'attached' })).toHaveProperty('reason');
  });
});

describe('actionOptionsProblem', () => {
  it('accepts options that do not change the action', () => {
    expect(actionOptionsProblem('click', { timeout: 5, force: true })).toBe(
      undefined,
    );
    expect(actionOptionsProblem('click', undefined)).toBe(undefined);
  });

  it('refuses options that change it', () => {
    expect(actionOptionsProblem('click', { button: 'right' })).toBe(
      'the option button has no scenario form',
    );
    expect(actionOptionsProblem('hover', { trial: true })).toMatch(/trial/);
    expect(actionOptionsProblem('press', { delay: 5 })).toMatch(/delay/);
  });
});

describe('screenshotStep', () => {
  it('names the step after the file, slugged', () => {
    expect(screenshotStep({ path: '/out/hover-tooltip.png' })).toEqual({
      step: { action: 'screenshot', name: 'hover-tooltip' },
    });
    expect(screenshotStep({ path: 'C:\\out\\Report Ready.PNG' })).toEqual({
      step: { action: 'screenshot', name: 'report-ready' },
    });
  });

  it('has no name without a path', () => {
    expect(screenshotStep(undefined)).toHaveProperty('reason');
    expect(screenshotStep({ fullPage: true })).toHaveProperty('reason');
  });
});

describe('scrollStep', () => {
  const at = (y: number, x = 0) => ({ x, y, maxY: 1000 });

  it('is nothing when the page did not move', () => {
    expect(scrollStep(at(0), at(0))).toBe(undefined);
  });

  it('records the top and the bottom', () => {
    expect(scrollStep(at(1000), at(0))).toEqual({
      step: { action: 'scroll', to: 'top' },
    });
    expect(scrollStep(at(0), at(999.5))).toEqual({
      step: { action: 'scroll', to: 'bottom' },
    });
  });

  it('has no form between the two, or sideways', () => {
    expect(scrollStep(at(0), at(400))).toHaveProperty('reason');
    expect(scrollStep(at(0), at(0, 50))).toHaveProperty('reason');
  });
});

describe('wheelStep', () => {
  const page = (y = 0) => ({ x: 0, y, maxY: 1000 });
  const log = { testId: 'log' };
  const from = (top: number, within: typeof log | null = log) => ({
    page: page(),
    container: { top, maxTop: 500, within },
  });
  const to = (top: number, y = 0) => ({
    page: page(y),
    container: { top, maxTop: 500 },
  });

  it('records the container at its top or bottom, within its locator', () => {
    expect(wheelStep(from(0), to(500))).toEqual({
      step: { action: 'scroll', to: 'bottom', within: log },
    });
    expect(wheelStep(from(500), to(0))).toEqual({
      step: { action: 'scroll', to: 'top', within: log },
    });
  });

  it('takes within a pixel of the maximum as the bottom', () => {
    expect(wheelStep(from(0), to(499.2))).toEqual({
      step: { action: 'scroll', to: 'bottom', within: log },
    });
  });

  it('reports a scroll that ends mid-container', () => {
    expect(wheelStep(from(0), to(200))).toEqual({
      reason: 'the scroll ends mid-container',
    });
  });

  it('reports a container with no locator', () => {
    expect(wheelStep(from(0, null), to(500))).toEqual({
      reason: 'the scroll container has no data-testid or id',
    });
  });

  it("applies the page's rule when the page moved", () => {
    expect(wheelStep(from(0), to(0, 1000))).toEqual({
      step: { action: 'scroll', to: 'bottom' },
    });
    expect(
      wheelStep(
        { page: page(), container: null },
        { page: page(1000), container: null },
      ),
    ).toEqual({ step: { action: 'scroll', to: 'bottom' } });
  });

  it('is nothing when neither moved, or there is no container', () => {
    expect(wheelStep(from(500), to(500))).toBe(undefined);
    expect(
      wheelStep(
        { page: page(), container: null },
        { page: page(), container: null },
      ),
    ).toBe(undefined);
  });
});

describe('assertionStep', () => {
  it('records toBeVisible, toHaveText and toContainText with a string', () => {
    expect(assertionStep('toBeVisible', target, [], false)).toEqual({
      step: { action: 'assertVisible', target },
    });
    expect(assertionStep('toHaveText', target, ['Pro'], false)).toEqual({
      step: { action: 'assertText', target, text: 'Pro', match: 'exact' },
    });
    expect(
      assertionStep('toContainText', target, ['Pro', { timeout: 5 }], false),
    ).toEqual({
      step: { action: 'assertText', target, text: 'Pro', match: 'contains' },
    });
  });

  it('leaves out what it cannot express', () => {
    const reasons = [
      assertionStep('toBeVisible', target, [], true),
      assertionStep('toHaveText', target, [/Pro/], false),
      assertionStep('toHaveText', target, [['a', 'b']], false),
      assertionStep('toHaveText', target, ['Pro', { ignoreCase: true }], false),
      assertionStep('toBeVisible', target, [{ visible: false }], false),
      assertionStep('toHaveValue', target, ['x'], false),
      assertionStep('toHaveText', target, [''], false),
    ];
    for (const mapped of reasons) expect(mapped).toHaveProperty('reason');
  });
});
