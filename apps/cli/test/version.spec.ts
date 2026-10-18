import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageVersion } from '../src/version.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'demoflow-version-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function manifest(at: string, content: object): Promise<void> {
  await mkdir(at, { recursive: true });
  await writeFile(path.join(at, 'package.json'), JSON.stringify(content));
}

describe('packageVersion', () => {
  it('is the version in apps/cli/package.json in the workspace', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reads the nearest demoflow manifest, skipping other packages', async () => {
    // The published layout: <pkg>/dist/bin/main.js, inside someone's project.
    await manifest(dir, { name: 'their-app', version: '9.9.9' });
    const pkg = path.join(dir, 'node_modules', 'demoflow');
    await manifest(pkg, { name: 'demoflow', version: '1.2.3' });
    await manifest(path.join(pkg, 'dist'), { type: 'module' });
    const bundle = pathToFileURL(path.join(pkg, 'dist', 'bin', 'main.js')).href;
    expect(packageVersion(bundle)).toBe('1.2.3');
  });

  it('reads the workspace manifest named @demoflow/cli', async () => {
    const pkg = path.join(dir, 'apps', 'cli');
    await manifest(pkg, { name: '@demoflow/cli', version: '4.5.6' });
    const source = pathToFileURL(path.join(pkg, 'src', 'version.ts')).href;
    expect(packageVersion(source)).toBe('4.5.6');
  });

  it('throws when no demoflow manifest is above it', async () => {
    const lonely = pathToFileURL(path.join(dir, 'main.js')).href;
    expect(() => packageVersion(lonely)).toThrow(/no demoflow package\.json/);
  });
});
