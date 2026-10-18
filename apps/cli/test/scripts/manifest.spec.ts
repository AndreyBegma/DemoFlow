import { describe, expect, it } from 'vitest';
import {
  BIN,
  type Manifest,
  publishManifest,
  runtimeDependencies,
} from '../../scripts/manifest.ts';

const cli: Manifest = {
  name: '@demoflow/cli',
  version: '0.1.0',
  license: 'MIT',
  engines: { node: '>=20' },
  dependencies: {
    '@demoflow/engine': 'workspace:*',
    '@demoflow/renderer': 'workspace:*',
    commander: '14.0.3',
  },
};

const workspace = new Map<string, Manifest>([
  ['@demoflow/core', { dependencies: { zod: '4.6.5' } }],
  [
    '@demoflow/engine',
    { dependencies: { '@demoflow/core': 'workspace:*', playwright: '1.64.1' } },
  ],
  [
    '@demoflow/renderer',
    {
      dependencies: {
        '@demoflow/core': 'workspace:*',
        'ffmpeg-static': '5.3.0',
      },
    },
  ],
]);

describe('runtimeDependencies', () => {
  it('replaces workspace packages with their third-party dependencies, sorted', () => {
    expect(runtimeDependencies(cli, workspace)).toEqual({
      commander: '14.0.3',
      'ffmpeg-static': '5.3.0',
      playwright: '1.64.1',
      zod: '4.6.5',
    });
    expect(Object.keys(runtimeDependencies(cli, workspace))).toEqual([
      'commander',
      'ffmpeg-static',
      'playwright',
      'zod',
    ]);
  });

  it('accepts the same dependency pinned identically twice', () => {
    const both: Manifest = {
      ...cli,
      dependencies: { ...cli.dependencies, zod: '4.6.5' },
    };
    expect(runtimeDependencies(both, workspace).zod).toBe('4.6.5');
  });

  it('rejects a dependency two packages pin differently', () => {
    const clash: Manifest = {
      ...cli,
      dependencies: { ...cli.dependencies, zod: '4.6.4' },
    };
    expect(() => runtimeDependencies(clash, workspace)).toThrow(
      /zod: @demoflow\/core pins 4\.6\.5, @demoflow\/cli pins 4\.6\.4/,
    );
  });

  it('rejects a range', () => {
    const ranged: Manifest = { dependencies: { commander: '^14.0.3' } };
    expect(() => runtimeDependencies(ranged, workspace)).toThrow(
      /commander@\^14\.0\.3: pin it/,
    );
  });

  it('rejects a workspace package it cannot find', () => {
    const missing: Manifest = {
      dependencies: { '@demoflow/nope': 'workspace:*' },
    };
    expect(() => runtimeDependencies(missing, workspace)).toThrow(
      /@demoflow\/nope, not in the workspace/,
    );
  });
});

describe('publishManifest', () => {
  it('has no workspace reference, no scripts and is not private', () => {
    const manifest = publishManifest(
      { ...cli, scripts: { build: 'x' }, private: true } as Manifest,
      workspace,
    );
    const text = JSON.stringify(manifest);
    expect(text).not.toContain('workspace:');
    expect(text).not.toContain('@demoflow/');
    expect(manifest).not.toHaveProperty('scripts');
    expect(manifest).not.toHaveProperty('private');
    expect(manifest).not.toHaveProperty('devDependencies');
    expect(manifest.name).toBe('demoflow');
    expect(manifest.bin).toEqual({ demoflow: BIN });
    expect(manifest.files).toEqual(['dist', 'fonts']);
    expect(manifest.version).toBe('0.1.0');
  });
});
