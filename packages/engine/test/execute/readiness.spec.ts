import { describe, expect, it } from 'vitest';
import { checkReadiness, OriginGuard } from '../../src/index.ts';
import { scenario } from './scenario.ts';

const allowedOrigins = ['http://localhost:3000'];

describe('OriginGuard', () => {
  const guard = new OriginGuard(allowedOrigins);

  it('allows a URL of an allowed origin', () => {
    expect(guard.check('http://localhost:3000/customers?q=1')).toBeUndefined();
  });

  it('refuses another scheme, host or port', () => {
    expect(guard.check('https://localhost:3000/')).toBe(
      'https://localhost:3000',
    );
    expect(guard.check('http://localhost:3001/')).toBe('http://localhost:3001');
    expect(guard.check('https://example.com/a')).toBe('https://example.com');
    expect(guard.check('file:///etc/passwd')).toBe('file:');
  });

  it('lets the blank page and Chromium error page through', () => {
    expect(guard.check('about:blank')).toBeUndefined();
    expect(guard.check('chrome-error://chromewebdata/')).toBeUndefined();
  });
});

describe('checkReadiness', () => {
  it('passes and resolves secrets by step index', () => {
    const result = checkReadiness(
      scenario([
        { action: 'navigate', path: '/login' },
        {
          action: 'fill',
          target: { label: 'Password' },
          valueFrom: { env: 'FIXTURE_PASSWORD' },
        },
      ]),
      {
        baseUrl: 'http://localhost:3000',
        allowedOrigins,
        env: { FIXTURE_PASSWORD: 'secret' },
      },
    );
    expect(result).toEqual({ ok: true, secrets: new Map([[1, 'secret']]) });
  });

  it('refuses a navigate outside the allowed origins', () => {
    const result = checkReadiness(
      scenario([
        { action: 'navigate', path: '/' },
        { action: 'navigate', url: 'https://example.com' },
      ]),
      { baseUrl: 'http://localhost:3000', allowedOrigins, env: {} },
    );
    expect(result).toEqual({
      ok: false,
      problem: {
        message: 'origin-not-allowed https://example.com',
        stepIndex: 1,
      },
    });
  });

  it('refuses a baseUrl outside the allowed origins', () => {
    const result = checkReadiness(scenario([{ action: 'wait', ms: 1 }]), {
      baseUrl: 'https://staging.example.com',
      allowedOrigins,
      env: {},
    });
    expect(result).toEqual({
      ok: false,
      problem: { message: 'origin-not-allowed https://staging.example.com' },
    });
  });

  it('reports a missing or empty environment variable', () => {
    const steps = scenario([
      {
        action: 'fill',
        target: { label: 'Password' },
        valueFrom: { env: 'FIXTURE_PASSWORD' },
      },
    ]);
    for (const env of [{}, { FIXTURE_PASSWORD: '' }]) {
      expect(
        checkReadiness(steps, { baseUrl: undefined, allowedOrigins, env }),
      ).toEqual({
        ok: false,
        problem: { message: 'missing-env FIXTURE_PASSWORD', stepIndex: 0 },
      });
    }
  });

  it('reports a path with no baseUrl to resolve it against', () => {
    expect(
      checkReadiness(scenario([{ action: 'navigate', path: '/x' }]), {
        baseUrl: undefined,
        allowedOrigins,
        env: {},
      }),
    ).toEqual({
      ok: false,
      problem: { message: 'missing-base-url /x', stepIndex: 0 },
    });
  });
});
