import { describe, expect, it } from 'vitest';
import {
  CliError,
  type GlobalConfig,
  globalConfigPath,
  type HostEnvironment,
  loadGlobalConfig,
  osDataDir,
  resolveHome,
  runDir,
} from '../../src/config/index.ts';

const linux: HostEnvironment = {
  platform: 'linux',
  env: {},
  homedir: '/home/ada',
};
const darwin: HostEnvironment = {
  platform: 'darwin',
  env: {},
  homedir: '/Users/ada',
};
const win32: HostEnvironment = {
  platform: 'win32',
  env: {},
  homedir: 'C:\\Users\\ada',
};

describe('globalConfigPath', () => {
  it.each([
    [
      'linux, XDG_CONFIG_HOME set',
      { ...linux, env: { XDG_CONFIG_HOME: '/cfg' } },
      '/cfg/demoflow/config.json',
    ],
    [
      'linux, XDG_CONFIG_HOME unset',
      linux,
      '/home/ada/.config/demoflow/config.json',
    ],
    [
      'linux, XDG_CONFIG_HOME relative is ignored',
      { ...linux, env: { XDG_CONFIG_HOME: 'cfg' } },
      '/home/ada/.config/demoflow/config.json',
    ],
    [
      'macOS',
      darwin,
      '/Users/ada/Library/Application Support/demoflow/config.json',
    ],
    [
      'Windows, APPDATA set',
      { ...win32, env: { APPDATA: 'D:\\Roaming' } },
      'D:\\Roaming\\demoflow\\config.json',
    ],
    [
      'Windows, APPDATA unset',
      win32,
      'C:\\Users\\ada\\AppData\\Roaming\\demoflow\\config.json',
    ],
  ] satisfies [
    string,
    HostEnvironment,
    string,
  ][])('%s', (_name, host, expected) => {
    expect(globalConfigPath(host)).toBe(expected);
  });
});

describe('osDataDir', () => {
  it.each([
    [
      'linux, XDG_DATA_HOME set',
      { ...linux, env: { XDG_DATA_HOME: '/data' } },
      '/data/demoflow',
    ],
    ['linux, XDG_DATA_HOME unset', linux, '/home/ada/.local/share/demoflow'],
    ['macOS', darwin, '/Users/ada/Library/Application Support/demoflow'],
    [
      'Windows, LOCALAPPDATA set',
      { ...win32, env: { LOCALAPPDATA: 'D:\\Local' } },
      'D:\\Local\\demoflow',
    ],
    [
      'Windows, LOCALAPPDATA unset',
      win32,
      'C:\\Users\\ada\\AppData\\Local\\demoflow',
    ],
  ] satisfies [
    string,
    HostEnvironment,
    string,
  ][])('%s', (_name, host, expected) => {
    expect(osDataDir(host)).toBe(expected);
  });
});

interface HomeCase {
  name: string;
  host: HostEnvironment;
  cwd: string;
  root: string;
  out?: string;
  env?: Record<string, string>;
  artifactsDir?: string;
  global?: GlobalConfig;
  expected: { home: string; source: string };
}

const homeCases: HomeCase[] = [
  // linux
  {
    name: 'linux: --out wins over everything',
    host: linux,
    cwd: '/work',
    root: '/proj',
    out: 'o',
    env: { DEMOFLOW_HOME: '/e' },
    artifactsDir: 'a',
    global: { artifactsDir: '/g' },
    expected: { home: '/work/o', source: 'out' },
  },
  {
    name: 'linux: DEMOFLOW_HOME beats configs',
    host: linux,
    cwd: '/work',
    root: '/proj',
    env: { DEMOFLOW_HOME: '/e' },
    artifactsDir: 'a',
    global: { artifactsDir: '/g' },
    expected: { home: '/e', source: 'env' },
  },
  {
    name: 'linux: project artifactsDir is relative to the root',
    host: linux,
    cwd: '/work',
    root: '/proj',
    artifactsDir: 'out/demos',
    global: { artifactsDir: '/g' },
    expected: { home: '/proj/out/demos', source: 'project-config' },
  },
  {
    name: 'linux: global artifactsDir',
    host: linux,
    cwd: '/work',
    root: '/proj',
    global: { artifactsDir: '/g' },
    expected: { home: '/g', source: 'global-config' },
  },
  {
    name: 'linux: OS data dir',
    host: linux,
    cwd: '/work',
    root: '/proj',
    expected: {
      home: '/home/ada/.local/share/demoflow',
      source: 'os-data-dir',
    },
  },
  // macOS
  {
    name: 'macOS: --out wins over everything',
    host: darwin,
    cwd: '/work',
    root: '/proj',
    out: '/abs',
    env: { DEMOFLOW_HOME: '/e' },
    artifactsDir: 'a',
    global: { artifactsDir: '/g' },
    expected: { home: '/abs', source: 'out' },
  },
  {
    name: 'macOS: DEMOFLOW_HOME beats configs',
    host: darwin,
    cwd: '/work',
    root: '/proj',
    env: { DEMOFLOW_HOME: 'rel' },
    artifactsDir: 'a',
    expected: { home: '/work/rel', source: 'env' },
  },
  {
    name: 'macOS: project artifactsDir',
    host: darwin,
    cwd: '/work',
    root: '/proj',
    artifactsDir: 'a',
    global: { artifactsDir: '/g' },
    expected: { home: '/proj/a', source: 'project-config' },
  },
  {
    name: 'macOS: global artifactsDir',
    host: darwin,
    cwd: '/work',
    root: '/proj',
    global: { artifactsDir: '/g' },
    expected: { home: '/g', source: 'global-config' },
  },
  {
    name: 'macOS: OS data dir',
    host: darwin,
    cwd: '/work',
    root: '/proj',
    expected: {
      home: '/Users/ada/Library/Application Support/demoflow',
      source: 'os-data-dir',
    },
  },
  // Windows
  {
    name: 'Windows: --out wins over everything',
    host: win32,
    cwd: 'C:\\work',
    root: 'C:\\proj',
    out: 'o',
    env: { DEMOFLOW_HOME: 'D:\\e' },
    artifactsDir: 'a',
    global: { artifactsDir: 'D:\\g' },
    expected: { home: 'C:\\work\\o', source: 'out' },
  },
  {
    name: 'Windows: DEMOFLOW_HOME beats configs',
    host: win32,
    cwd: 'C:\\work',
    root: 'C:\\proj',
    env: { DEMOFLOW_HOME: 'D:\\e' },
    artifactsDir: 'a',
    global: { artifactsDir: 'D:\\g' },
    expected: { home: 'D:\\e', source: 'env' },
  },
  {
    name: 'Windows: project artifactsDir is relative to the root',
    host: win32,
    cwd: 'C:\\work',
    root: 'C:\\proj',
    artifactsDir: 'out/demos',
    global: { artifactsDir: 'D:\\g' },
    expected: { home: 'C:\\proj\\out\\demos', source: 'project-config' },
  },
  {
    name: 'Windows: global artifactsDir',
    host: win32,
    cwd: 'C:\\work',
    root: 'C:\\proj',
    global: { artifactsDir: 'D:\\g' },
    expected: { home: 'D:\\g', source: 'global-config' },
  },
  {
    name: 'Windows: OS data dir',
    host: win32,
    cwd: 'C:\\work',
    root: 'C:\\proj',
    expected: {
      home: 'C:\\Users\\ada\\AppData\\Local\\demoflow',
      source: 'os-data-dir',
    },
  },
];

describe('resolveHome', () => {
  it.each(homeCases)('$name', (c) => {
    expect(
      resolveHome({
        platform: c.host.platform,
        homedir: c.host.homedir,
        env: { ...c.host.env, ...c.env },
        cwd: c.cwd,
        projectRoot: c.root,
        out: c.out,
        projectConfig: { artifactsDir: c.artifactsDir },
        globalConfig: c.global ?? {},
      }),
    ).toEqual(c.expected);
  });

  it('treats an empty --out and an empty DEMOFLOW_HOME as unset', () => {
    expect(
      resolveHome({
        ...linux,
        env: { DEMOFLOW_HOME: '' },
        cwd: '/work',
        projectRoot: '/proj',
        out: '',
        projectConfig: {},
        globalConfig: {},
      }).source,
    ).toBe('os-data-dir');
  });
});

describe('runDir', () => {
  it.each([
    ['linux', '/h', '/h/runs/r1'],
    ['darwin', '/h', '/h/runs/r1'],
    ['win32', 'C:\\h', 'C:\\h\\runs\\r1'],
  ] as const)('%s', (platform, home, expected) => {
    expect(runDir(home, 'r1', platform)).toBe(expected);
  });
});

describe('loadGlobalConfig', () => {
  const enoent = () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };

  it('treats a missing file as an empty config', () => {
    expect(loadGlobalConfig(linux, enoent)).toEqual({});
  });

  it('reads only artifactsDir and ignores other keys', () => {
    const read = () => JSON.stringify({ artifactsDir: '/g', other: 1 });
    expect(loadGlobalConfig(linux, read)).toEqual({ artifactsDir: '/g' });
  });

  it("resolves a relative artifactsDir against the config file's directory", () => {
    const read = () => JSON.stringify({ artifactsDir: '../demos' });
    expect(loadGlobalConfig(linux, read)).toEqual({
      artifactsDir: '/home/ada/.config/demos',
    });
    expect(loadGlobalConfig(win32, read)).toEqual({
      artifactsDir: 'C:\\Users\\ada\\AppData\\Roaming\\demos',
    });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['not an object', '[]'],
    ['artifactsDir not a string', '{"artifactsDir": 1}'],
    ['artifactsDir empty', '{"artifactsDir": ""}'],
  ])('rejects %s with invalid-global-config (exit 2)', (_name, text) => {
    try {
      loadGlobalConfig(linux, () => text);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('invalid-global-config');
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});
