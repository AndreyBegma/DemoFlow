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
          cards: {
            intro: { enabled: true, durationMs: 2000 },
            scenes: { enabled: true, durationMs: 1500 },
            outro: { durationMs: 2500 },
          },
          transitions: { enabled: true, durationMs: 300 },
          formats: ['mp4'],
          gif: { width: 800, fps: 12 },
        },
      },
    });
  });

  it('keeps the formats given, in order, and the GIF settings', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { formats: ['gif', 'mp4', 'webm'], gif: { width: 640, fps: 10 } },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        render: {
          formats: ['gif', 'mp4', 'webm'],
          gif: { width: 640, fps: 10 },
        },
      },
    });
  });

  it('clamps the GIF defaults to a smaller render', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { width: 640, height: 360, fps: 10, formats: ['gif'] },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { render: { gif: { width: 640, fps: 10 } } },
    });
  });

  it.each([
    [{ formats: [] }, 'render.formats'],
    [{ formats: ['mp4', 'mp4'] }, 'render.formats'],
    [{ formats: ['avi'] }, 'render.formats[0]'],
    [{ gif: { width: 1921 } }, 'render.gif.width'],
    [{ gif: { width: 159 } }, 'render.gif.width'],
    [{ gif: { fps: 31 } }, 'render.gif.fps'],
    [{ width: 1280, height: 720, gif: { width: 1281 } }, 'render.gif.width'],
  ])('rejects the render %o at %s', (render, path) => {
    const result = parseProjectConfig({ baseUrl: 'https://a.example', render });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({ path }));
    }
  });

  it('keeps the transitions given, filling the rest', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { transitions: { durationMs: 750 } },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { render: { transitions: { enabled: true, durationMs: 750 } } },
    });
  });

  it.each([
    [{ durationMs: 99 }],
    [{ durationMs: 1001 }],
    [{ durationMs: 300.5 }],
    [{ style: 'wipe' }],
  ])('rejects the transitions %o', (transitions) => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { transitions },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a fade longer than half the shortest card that is on', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: {
        cards: { scenes: { durationMs: 500 } },
        transitions: { durationMs: 300 },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ path: 'render.transitions.durationMs' }),
      );
    }
  });

  it('counts only the cards that are on, and nothing with transitions off', () => {
    const scenes = { enabled: false, durationMs: 500 };
    for (const render of [
      { cards: { scenes }, transitions: { durationMs: 1000 } },
      {
        cards: { scenes: { durationMs: 500 } },
        transitions: { enabled: false, durationMs: 1000 },
      },
    ]) {
      expect(
        parseProjectConfig({ baseUrl: 'https://a.example', render }).ok,
      ).toBe(true);
    }
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

  it('keeps the cards given, filling the rest', () => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: {
        cards: {
          intro: { enabled: false },
          scenes: { durationMs: 500 },
          outro: { title: 'Acme', cta: 'acme.dev/try', durationMs: 10_000 },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        render: {
          cards: {
            intro: { enabled: false, durationMs: 2000 },
            scenes: { enabled: true, durationMs: 500 },
            outro: { title: 'Acme', cta: 'acme.dev/try', durationMs: 10_000 },
          },
          // The default fade shrinks to half the shortest card (#114).
          transitions: { enabled: true, durationMs: 250 },
        },
      },
    });
  });

  it.each([
    [{ intro: { durationMs: 499 } }, 'render.cards.intro.durationMs'],
    [{ intro: { durationMs: 10_001 } }, 'render.cards.intro.durationMs'],
    [{ scenes: { durationMs: 1500.5 } }, 'render.cards.scenes.durationMs'],
    [
      { outro: { title: 'Acme', durationMs: 0 } },
      'render.cards.outro.durationMs',
    ],
    [{ outro: { title: '' } }, 'render.cards.outro.title'],
    [{ outro: { title: '   ' } }, 'render.cards.outro.title'],
    [{ outro: { title: 'x'.repeat(81) } }, 'render.cards.outro.title'],
    [{ outro: { title: 'Acme', cta: '' } }, 'render.cards.outro.cta'],
    [
      { outro: { title: 'Acme', cta: 'x'.repeat(81) } },
      'render.cards.outro.cta',
    ],
    [{ outro: { logo: 'logo.png' } }, 'render.cards.outro.logo'],
  ])('rejects the cards %o at %s', (cards, path) => {
    const result = parseProjectConfig({
      baseUrl: 'https://a.example',
      render: { cards },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({ path }));
    }
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
