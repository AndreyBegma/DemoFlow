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
          frame: { enabled: true, marginRatio: 0.06, radius: 12, shadow: true },
          background: { preset: 'ocean' },
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
          frame: { enabled: true, marginRatio: 0.06, radius: 12, shadow: true },
          background: { preset: 'ocean' },
        },
      },
    });
  });

  it.each([
    [{ preset: 'sunset' }],
    [{ color: '#1E3A5F' }],
    [{ gradient: { from: '#000000', to: '#ffffff', angle: 90 } }],
  ])('accepts the background %o', (background) => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { background },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { render: { background } },
    });
  });

  it('keeps a frame turned off, filling the rest', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { frame: { enabled: false } },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        render: {
          frame: {
            enabled: false,
            marginRatio: 0.06,
            radius: 12,
            shadow: true,
          },
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
    [
      {
        baseUrl: 'https://a.example',
        render: { background: { preset: 'neon' } },
      },
      'render.background.preset',
    ],
    [
      {
        baseUrl: 'https://a.example',
        render: { background: { color: 'red' } },
      },
      'render.background.color',
    ],
    [
      {
        baseUrl: 'https://a.example',
        render: { background: { color: '#12345' } },
      },
      'render.background.color',
    ],
    [
      {
        baseUrl: 'https://a.example',
        render: {
          background: { gradient: { from: '#000000', to: '#fff', angle: 0 } },
        },
      },
      'render.background.gradient.to',
    ],
    [
      {
        baseUrl: 'https://a.example',
        render: {
          background: {
            gradient: { from: '#000000', to: '#ffffff', angle: 400 },
          },
        },
      },
      'render.background.gradient.angle',
    ],
    [
      {
        baseUrl: 'https://a.example',
        render: { background: { image: 'bg.png' } },
      },
      'render.background',
    ],
    [
      {
        baseUrl: 'https://a.example',
        render: { background: { preset: 'ocean', color: '#000000' } },
      },
      'render.background',
    ],
    [
      { baseUrl: 'https://a.example', render: { frame: { marginRatio: 0.3 } } },
      'render.frame.marginRatio',
    ],
    [
      { baseUrl: 'https://a.example', render: { frame: { radius: -1 } } },
      'render.frame.radius',
    ],
  ])('rejects %o at %s', (input, path) => {
    const result = parseProjectConfig(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({ path }));
    }
  });
});
