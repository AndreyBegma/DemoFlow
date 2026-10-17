import { describe, expect, it } from 'vitest';
import { parseProjectConfig } from '../src/index.ts';

describe('parseProjectConfig', () => {
  it('applies the defaults of ADR-0004 and the origin of baseUrl', () => {
    expect(
      parseProjectConfig({ baseUrl: 'http://localhost:3000/app' }),
    ).toEqual({
      ok: true,
      warnings: [],
      value: {
        baseUrl: 'http://localhost:3000/app',
        allowedOrigins: ['http://localhost:3000'],
        render: {
          width: 1920,
          height: 1080,
          fps: 30,
          idle: { thresholdMs: 1000, compressToMs: 400 },
        },
      },
    });
  });

  it('keeps what is given and fills the rest of render', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://staging.example.com',
      allowedOrigins: [
        'https://staging.example.com',
        'https://auth.example.com',
      ],
      devCommand: {
        command: 'bun',
        args: ['run', 'dev'],
        readyUrl: 'http://localhost:3000/health',
        timeoutMs: 60_000,
      },
      artifactsDir: '.demoflow',
      render: { fps: 60, idle: { thresholdMs: 2000 } },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        allowedOrigins: [
          'https://staging.example.com',
          'https://auth.example.com',
        ],
        devCommand: {
          command: 'bun',
          readyUrl: 'http://localhost:3000/health',
        },
        render: {
          width: 1920,
          height: 1080,
          fps: 60,
          idle: { thresholdMs: 2000, compressToMs: 400 },
        },
      },
    });
  });

  it.each([
    [{}, 'baseUrl'],
    [{ baseUrl: 'file:///srv' }, 'baseUrl'],
    [
      { baseUrl: 'https://a.example', allowedOrigins: ['https://a.example/x'] },
      'allowedOrigins[0]',
    ],
    [
      { baseUrl: 'https://a.example', allowedOrigins: ['javascript:alert(1)'] },
      'allowedOrigins[0]',
    ],
    [
      { baseUrl: 'https://a.example', devCommand: { command: 'bun' } },
      'devCommand.readyUrl',
    ],
    [{ baseUrl: 'https://a.example', render: { fps: 0 } }, 'render.fps'],
    [{ baseUrl: 'https://a.example', plugins: [] }, 'plugins'],
  ])('rejects %o at %s', (input, path) => {
    const result = parseProjectConfig(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({ path }));
    }
  });
});
