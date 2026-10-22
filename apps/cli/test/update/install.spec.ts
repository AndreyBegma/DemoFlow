import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostEnvironment } from '../../src/config/platform.ts';
import {
  detectInstall,
  installCommand,
  packageLocation,
} from '../../src/update/install.ts';

const linux: HostEnvironment = {
  platform: 'linux',
  env: {},
  homedir: '/home/ada',
};
const mac: HostEnvironment = {
  platform: 'darwin',
  env: {},
  homedir: '/Users/ada',
};
const windows: HostEnvironment = {
  platform: 'win32',
  env: {
    APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
  },
  homedir: 'C:\\Users\\Ada',
};

function at(dir: string, host: HostEnvironment, execPath = '/usr/bin/node') {
  return detectInstall({ dir, name: 'demoflow' }, host, execPath);
}

describe('detectInstall', () => {
  it('is source for the workspace checkout', () => {
    expect(
      detectInstall(
        { dir: '/src/DemoFlow/apps/cli', name: '@demoflow/cli' },
        linux,
        '/usr/bin/node',
      ),
    ).toEqual({ kind: 'source' });
  });

  it.each([
    ['npx', '/home/ada/.npm/_npx/1a2b3c/node_modules/demoflow', linux],
    ['bunx', '/tmp/bunx-1000-demoflow@latest/node_modules/demoflow', linux],
    [
      'pnpm dlx',
      '/home/ada/.cache/pnpm/dlx/abc/node_modules/.pnpm/demoflow@0.1.0/node_modules/demoflow',
      linux,
    ],
    [
      'npx on Windows',
      'C:\\Users\\Ada\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\demoflow',
      windows,
    ],
  ])('is ephemeral under %s', (_name, dir, host) => {
    expect(at(dir, host)).toEqual({ kind: 'ephemeral' });
  });

  it('is ephemeral when npm runs it as exec', () => {
    expect(
      at('/home/ada/app/node_modules/demoflow', {
        ...linux,
        env: { npm_command: 'exec' },
      }),
    ).toEqual({ kind: 'ephemeral' });
  });

  it.each([
    [
      'nvm',
      '/home/ada/.nvm/versions/node/v22.0.0/lib/node_modules/demoflow',
      '/home/ada/.nvm/versions/node/v22.0.0/bin/node',
      linux,
    ],
    [
      'system',
      '/usr/local/lib/node_modules/demoflow',
      '/usr/local/bin/node',
      linux,
    ],
    [
      'homebrew',
      '/opt/homebrew/lib/node_modules/demoflow',
      '/opt/homebrew/bin/node',
      mac,
    ],
    [
      'a custom prefix',
      '/home/ada/.npm-global/lib/node_modules/demoflow',
      '/usr/bin/node',
      linux,
    ],
    [
      'Windows %APPDATA%\\npm',
      'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\demoflow',
      'C:\\Program Files\\nodejs\\node.exe',
      windows,
    ],
    [
      'Windows beside node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\demoflow',
      'C:\\Program Files\\nodejs\\node.exe',
      windows,
    ],
  ])('is a global npm install under %s', (_name, dir, execPath, host) => {
    expect(at(dir, host, execPath)).toEqual({ kind: 'global', manager: 'npm' });
  });

  it.each([
    ['bun', '/home/ada/.bun/install/global/node_modules/demoflow', linux],
    [
      'bun with BUN_INSTALL',
      '/opt/bun/install/global/node_modules/demoflow',
      { ...linux, env: { BUN_INSTALL: '/opt/bun' } },
    ],
    [
      'bun on Windows',
      'C:\\Users\\Ada\\.bun\\install\\global\\node_modules\\demoflow',
      windows,
    ],
    [
      'pnpm',
      '/home/ada/.local/share/pnpm/global/5/.pnpm/demoflow@0.1.0/node_modules/demoflow',
      linux,
    ],
    [
      'pnpm with PNPM_HOME',
      '/opt/p/global/5/node_modules/demoflow',
      { ...linux, env: { PNPM_HOME: '/opt/p' } },
    ],
    [
      'pnpm on Windows',
      'C:\\Users\\Ada\\AppData\\Local\\pnpm\\global\\5\\node_modules\\demoflow',
      windows,
    ],
    ['yarn', '/home/ada/.config/yarn/global/node_modules/demoflow', linux],
    [
      'yarn on Windows',
      'C:\\Users\\Ada\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\demoflow',
      windows,
    ],
  ])('is a global %s install', (name, dir, host) => {
    const manager = name.split(' ')[0];
    expect(at(dir, host)).toEqual({ kind: 'global', manager });
  });

  it('is local inside a project', () => {
    expect(at('/home/ada/app/node_modules/demoflow', linux)).toEqual({
      kind: 'local',
    });
    expect(
      at(
        'C:\\work\\app\\node_modules\\demoflow',
        windows,
        'C:\\node\\node.exe',
      ),
    ).toEqual({ kind: 'local' });
  });

  it('is unknown anywhere else', () => {
    expect(at('/opt/demoflow', linux)).toEqual({ kind: 'unknown' });
  });
});

describe('installCommand', () => {
  it('is the global install of each manager', () => {
    expect(installCommand('npm', '0.2.0')).toEqual([
      'npm',
      'install',
      '-g',
      'demoflow@0.2.0',
    ]);
    expect(installCommand('bun', '0.2.0')).toEqual([
      'bun',
      'add',
      '-g',
      'demoflow@0.2.0',
    ]);
    expect(installCommand('pnpm', '0.2.0')).toEqual([
      'pnpm',
      'add',
      '-g',
      'demoflow@0.2.0',
    ]);
    expect(installCommand('yarn', '0.2.0')).toEqual([
      'yarn',
      'global',
      'add',
      'demoflow@0.2.0',
    ]);
  });
});

describe('packageLocation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'demoflow-install-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is the workspace package here', () => {
    expect(packageLocation()?.name).toBe('@demoflow/cli');
  });

  it('follows a symlinked bin to the real package', async () => {
    const real = path.join(dir, 'lib', 'node_modules', 'demoflow');
    await mkdir(path.join(real, 'dist', 'bin'), { recursive: true });
    await writeFile(
      path.join(real, 'package.json'),
      JSON.stringify({ name: 'demoflow', version: '0.1.0' }),
    );
    const link = path.join(dir, 'linked');
    await symlink(real, link, 'junction');
    const bundle = pathToFileURL(path.join(link, 'dist', 'bin', 'main.js'));
    const found = packageLocation(bundle.href);
    expect(found?.name).toBe('demoflow');
    expect(found?.dir).toBe(await realpath(real));
  });
});
