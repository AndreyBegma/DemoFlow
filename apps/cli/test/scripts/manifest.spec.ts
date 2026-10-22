import { describe, expect, it } from 'vitest';
import {
  BIN,
  type Manifest,
  PLAYWRIGHT_ENTRY,
  PLAYWRIGHT_TYPES,
  peerDependencies,
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

  it('exports demoflow/playwright and the manifest, nothing else', () => {
    expect(publishManifest(cli, workspace).exports).toEqual({
      './playwright': {
        types: `./${PLAYWRIGHT_TYPES}`,
        import: `./${PLAYWRIGHT_ENTRY}`,
      },
      './package.json': './package.json',
    });
    expect(PLAYWRIGHT_ENTRY).toBe('dist/playwright/index.js');
    expect(PLAYWRIGHT_TYPES).toBe('dist/playwright/index.d.ts');
  });

  it('carries the optional peer dependency, never as a dependency', () => {
    const manifest = publishManifest(withPeer, workspace);
    expect(manifest.peerDependencies).toEqual({
      '@playwright/test': '>=1.62.0 <2.0.0',
    });
    expect(manifest.peerDependenciesMeta).toEqual({
      '@playwright/test': { optional: true },
    });
    expect(manifest.dependencies).not.toHaveProperty('@playwright/test');
  });

  it('has empty peer fields when the CLI declares none', () => {
    const manifest = publishManifest(cli, workspace);
    expect(manifest.peerDependencies).toEqual({});
    expect(manifest.peerDependenciesMeta).toEqual({});
  });
});

const withPeer: Manifest = {
  ...cli,
  peerDependencies: { '@playwright/test': '>=1.62.0 <2.0.0' },
  peerDependenciesMeta: { '@playwright/test': { optional: true } },
};

describe('peerDependencies', () => {
  it('rejects a peer that is not optional', () => {
    expect(() =>
      peerDependencies({ ...withPeer, peerDependenciesMeta: {} }),
    ).toThrow(/@playwright\/test is a peer dependency: mark it optional/);
  });

  it('rejects a peer that is also a runtime dependency', () => {
    const both: Manifest = {
      ...withPeer,
      dependencies: { ...cli.dependencies, '@playwright/test': '1.64.1' },
    };
    expect(() => publishManifest(both, workspace)).toThrow(
      /@playwright\/test is a peer dependency and a runtime dependency/,
    );
  });
});
