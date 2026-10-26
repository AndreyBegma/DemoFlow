import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../../src/commands/io.ts';
import type { HostEnvironment } from '../../src/config/platform.ts';
import {
  checkProject,
  type LaunchStats,
  nodeLaunchFs,
} from '../../src/runner/launch/checks.ts';
import { loadProjectFor } from '../../src/runner/launch/index.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import {
  ALLOWED_ROOTS_MAX,
  readAllowedRoots,
} from '../../src/runner/roots/allowed.ts';
import {
  allowCommand,
  disallowCommand,
  rootsCommand,
} from '../../src/runner/roots/commands.ts';
import {
  githubUrlFrom,
  githubUrlOf,
  originUrl,
} from '../../src/runner/roots/git-remote.ts';
import {
  defaultWriteTemplate,
  isWebsiteRegistered,
  PROJECT_REQUEST_MAX_MS,
  ProjectRequests,
  type ProjectsDeps,
} from '../../src/runner/roots/index.ts';
import {
  isAllowedPath,
  type PathFs,
} from '../../src/runner/roots/path-rule.ts';
import {
  registerWebsiteProject,
  WEBSITE_PROJECTS_MAX,
  websiteRoots,
} from '../../src/runner/roots/registry.ts';
import { FakeClock, memoryLogger } from './fakes.ts';

const REQUEST = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';
const FIXTURE = readFileSync(
  path.join(
    import.meta.dirname,
    '../../../fixture/demoflow/customers.demo.json',
  ),
  'utf8',
);
const CONFIG = JSON.stringify({
  baseUrl: 'http://localhost:4123',
  devCommand: {
    command: 'secret-dev-command',
    readyUrl: 'http://localhost:4123',
  },
});

let tmp: string;
let home: string;
let outside: string;
let host: HostEnvironment;
let clock: FakeClock;
let logger: ReturnType<typeof memoryLogger>;
let sent: Array<Record<string, unknown>>;

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function dir(...parts: string[]): string {
  const target = path.join(...parts);
  mkdirSync(target, { recursive: true });
  return target;
}

/** A directory link; a junction on Windows, which needs no privilege. */
function link(target: string, at: string): void {
  symlinkSync(target, at, 'junction');
}

function files() {
  return runnerPaths(host);
}

function deps(overrides: Partial<ProjectsDeps> = {}): ProjectsDeps {
  return {
    allowedRootsFile: files().allowedRoots,
    websiteProjectsFile: files().websiteProjects,
    host,
    fs: nodeLaunchFs,
    logger,
    clock,
    loadProject: loadProjectFor(host),
    writeTemplate: defaultWriteTemplate,
    ...overrides,
  };
}

function requests(overrides: Partial<ProjectsDeps> = {}): ProjectRequests {
  return new ProjectRequests(deps(overrides));
}

async function ask(
  type: string,
  target: unknown,
  handler: ProjectRequests = requests(),
): Promise<Record<string, unknown>> {
  const before = sent.length;
  handler.handle(
    { type, requestId: REQUEST, path: target },
    { send: (message) => sent.push(message) },
  );
  await vi.waitFor(() => expect(sent.length).toBe(before + 1));
  return sent[before] as Record<string, unknown>;
}

const refused = {
  type: 'project.error',
  requestId: REQUEST,
  code: 'path-not-allowed',
};

function memoryIo(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io as Io & { out: string; err: string };
}

const commandDeps = () => ({ host, cwd: home });

beforeEach(() => {
  tmp = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-roots-')),
  );
  home = dir(tmp, 'home');
  outside = dir(tmp, 'outside');
  host = { platform: process.platform, env: {}, homedir: home };
  clock = new FakeClock();
  logger = memoryLogger();
  sent = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('the path rule on this machine', () => {
  it('allows a folder in the home directory by default, nothing hidden and nothing outside', async () => {
    const app = dir(home, 'work', 'app');
    const ssh = dir(home, '.ssh');
    const hiddenParent = dir(home, '.config', 'app');
    const answer = await ask('project.inspect', app);
    expect(answer).toMatchObject({
      type: 'project.inspected',
      requestId: REQUEST,
      inspection: { rootPath: app, name: 'app' },
    });
    for (const target of [ssh, hiddenParent, outside, tmp]) {
      expect(await ask('project.inspect', target)).toEqual(refused);
    }
  });

  it('refuses a link inside home that points outside, and a .. that leaves the root', async () => {
    const at = path.join(home, 'out');
    link(outside, at);
    expect(await ask('project.inspect', at)).toEqual(refused);
    expect(await ask('project.inspect', path.join(at, '.'))).toEqual(refused);
    expect(
      await ask('project.inspect', `${home}${path.sep}..${path.sep}outside`),
    ).toEqual(refused);
    if (process.platform !== 'win32') {
      // POSIX resolves `..` after the link: `jump/..` is `outside`, not `inner`.
      dir(home, 'inner');
      link(dir(outside, 'deep'), path.join(home, 'inner', 'jump'));
      expect(
        await ask('project.inspect', `${path.join(home, 'inner', 'jump')}/..`),
      ).toEqual(refused);
    }
  });

  it('refuses a relative path, a file, a folder that does not exist, and a non-string', async () => {
    write(path.join(home, 'note.txt'), 'x');
    for (const target of [
      'work/app',
      path.join(home, 'note.txt'),
      path.join(home, 'missing'),
      42,
      '',
      'x'.repeat(4097),
    ]) {
      expect(await ask('project.inspect', target)).toEqual(refused);
    }
  });

  it('accepts another case of the path where the file system ignores case', async () => {
    const app = dir(home, 'App');
    const variant = path.join(home, 'APP');
    const answer = await ask('project.inspect', variant);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(answer).toMatchObject({
        type: 'project.inspected',
        inspection: { rootPath: realpathSync.native(variant) },
      });
    } else {
      expect(answer).toEqual(refused);
    }
    expect(await ask('project.inspect', app)).toMatchObject({
      type: 'project.inspected',
    });
  });
});

/** A file system of directories only, for another platform's rules. */
function fakeFs(
  platform: NodeJS.Platform,
  dirs: string[],
  links: Record<string, string> = {},
): PathFs {
  const fold = (value: string) =>
    platform === 'linux' ? value : value.toLowerCase();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const real = new Map(dirs.map((d) => [fold(d), d]));
  const stats = (directory: boolean): LaunchStats => ({
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  });
  return {
    realpath: async (file) => {
      const resolved = p.resolve(file);
      const linked = links[fold(resolved)];
      if (linked !== undefined) return linked;
      const found = real.get(fold(resolved));
      if (found === undefined) throw new Error('ENOENT');
      return found;
    },
    lstat: async (file) => {
      if (!real.has(fold(file))) throw new Error('ENOENT');
      return stats(true);
    },
  };
}

describe('the path rule on other platforms', () => {
  it('compares without case and needs a drive letter on Windows', async () => {
    const fs = fakeFs('win32', [
      'C:\\Users\\Ann',
      'C:\\Users\\Ann\\Work',
      'C:\\Users\\Ann\\.ssh',
      'D:\\Work',
    ]);
    const roots = ['C:\\Users\\Ann'];
    expect(
      await isAllowedPath('c:\\users\\ann\\work', roots, 'win32', fs),
    ).toEqual({ ok: true, root: 'C:\\Users\\Ann\\Work' });
    expect(
      await isAllowedPath('C:/Users/Ann/Work/', roots, 'win32', fs),
    ).toEqual({ ok: true, root: 'C:\\Users\\Ann\\Work' });
    for (const raw of [
      'C:\\Users\\Ann\\.ssh',
      'D:\\Work',
      '\\\\server\\share\\Work',
      '\\\\?\\C:\\Users\\Ann\\Work',
      '\\Users\\Ann\\Work',
      'Users\\Ann\\Work',
    ]) {
      expect(await isAllowedPath(raw, roots, 'win32', fs)).toEqual({
        ok: false,
      });
    }
  });

  it('refuses a junction whose real path is elsewhere on Windows', async () => {
    const fs = fakeFs('win32', ['C:\\Users\\Ann', 'D:\\Secret'], {
      'c:\\users\\ann\\link': 'D:\\Secret',
    });
    expect(
      await isAllowedPath(
        'C:\\Users\\Ann\\link',
        ['C:\\Users\\Ann'],
        'win32',
        fs,
      ),
    ).toEqual({ ok: false });
  });

  it('compares without case on macOS and with case on Linux', async () => {
    const dirs = ['/Users/ann', '/Users/ann/Work'];
    expect(
      await isAllowedPath(
        '/users/ann/work',
        ['/Users/ann'],
        'darwin',
        fakeFs('darwin', dirs),
      ),
    ).toEqual({ ok: true, root: '/Users/ann/Work' });
    expect(
      await isAllowedPath(
        '/home/ann/Work',
        ['/home/ann'],
        'linux',
        fakeFs('linux', ['/home/ann', '/home/ann/Work']),
      ),
    ).toEqual({ ok: true, root: '/home/ann/Work' });
    expect(
      await isAllowedPath(
        '/home/ann/Work',
        ['/home/Ann'],
        'linux',
        fakeFs('linux', ['/home/ann', '/home/Ann', '/home/ann/Work']),
      ),
    ).toEqual({ ok: false });
  });

  it('allows a hidden folder that is itself a root, and a folder below the root /', async () => {
    const fs = fakeFs('linux', [
      '/',
      '/home/ann',
      '/home/ann/.config',
      '/home/ann/.config/app',
      '/srv/app',
    ]);
    expect(
      await isAllowedPath(
        '/home/ann/.config/app',
        ['/home/ann', '/home/ann/.config'],
        'linux',
        fs,
      ),
    ).toEqual({ ok: true, root: '/home/ann/.config/app' });
    expect(await isAllowedPath('/srv/app', ['/'], 'linux', fs)).toEqual({
      ok: true,
      root: '/srv/app',
    });
  });
});

describe('the allowed roots commands', () => {
  it('allow narrows from the home directory to one root, disallow of the last refuses everything', async () => {
    const work = dir(home, 'work');
    const app = dir(work, 'app');
    const other = dir(home, 'other');
    const io = memoryIo();
    expect(allowCommand('work', io, commandDeps())).toBe(0);
    expect(io.out).toContain(`Allowed: ${work}`);
    expect(io.out).toContain('home directory');
    expect(readAllowedRoots(files().allowedRoots, host)).toEqual({
      source: 'file',
      roots: [work],
    });
    expect(await ask('project.inspect', other)).toEqual(refused);
    expect(await ask('project.inspect', app)).toMatchObject({
      type: 'project.inspected',
    });

    expect(disallowCommand(work, memoryIo(), commandDeps())).toBe(0);
    expect(readAllowedRoots(files().allowedRoots, host)).toEqual({
      source: 'file',
      roots: [],
    });
    expect(await ask('project.inspect', app)).toEqual(refused);
    expect(await ask('project.inspect', other)).toEqual(refused);
  });

  it('writes the file with mode 600', () => {
    dir(home, 'work');
    allowCommand('work', memoryIo(), commandDeps());
    if (process.platform !== 'win32') {
      expect(statSync(files().allowedRoots).mode & 0o777).toBe(0o600);
    }
  });

  it('lists the default marked, then the roots as JSON', () => {
    const io = memoryIo();
    expect(rootsCommand({}, io, commandDeps())).toBe(0);
    expect(io.out).toBe(`${home}  (default: the home directory)\n`);
    const work = dir(home, 'work');
    allowCommand(work, memoryIo(), commandDeps());
    const json = memoryIo();
    expect(rootsCommand({ json: true }, json, commandDeps())).toBe(0);
    expect(JSON.parse(json.out)).toEqual({
      roots: [work],
      default: false,
      valid: true,
    });
  });

  it('refuses every path when the file is corrupt, and roots says so', async () => {
    write(files().allowedRoots, '{ "roots": [');
    expect(await ask('project.inspect', dir(home, 'app'))).toEqual(refused);
    const io = memoryIo();
    expect(rootsCommand({}, io, commandDeps())).toBe(1);
    expect(io.err).toMatch(/is invalid/);
    const json = memoryIo();
    rootsCommand({ json: true }, json, commandDeps());
    expect(JSON.parse(json.out)).toMatchObject({ roots: [], valid: false });
  });

  it('treats a file with a relative or too many roots as invalid', () => {
    write(files().allowedRoots, JSON.stringify({ roots: ['work'] }));
    expect(readAllowedRoots(files().allowedRoots, host).source).toBe('invalid');
    write(
      files().allowedRoots,
      JSON.stringify({
        roots: Array.from({ length: ALLOWED_ROOTS_MAX + 1 }, () => home),
      }),
    );
    expect(readAllowedRoots(files().allowedRoots, host).source).toBe('invalid');
  });

  it('refuses to allow a path that is not a directory, and reports a root it does not hold', () => {
    const io = memoryIo();
    expect(allowCommand('missing', io, commandDeps())).not.toBe(0);
    expect(io.err).toMatch(/Not a directory/);
    const gone = memoryIo();
    expect(disallowCommand(outside, gone, commandDeps())).toBe(1);
    expect(gone.err).toMatch(/Not an allowed root/);
  });

  it('disallows a root that no longer exists by its resolved path', () => {
    const work = dir(home, 'work');
    allowCommand(work, memoryIo(), commandDeps());
    allowCommand(outside, memoryIo(), commandDeps());
    rmSync(work, { recursive: true });
    expect(disallowCommand(work, memoryIo(), commandDeps())).toBe(0);
    expect(readAllowedRoots(files().allowedRoots, host).roots).toEqual([
      outside,
    ]);
  });
});

describe('inspection', () => {
  it('answers hasConfig false and no scenarios for a folder without config', async () => {
    const app = dir(home, 'app');
    write(path.join(app, 'demoflow', 'a.demo.json'), FIXTURE);
    expect(await ask('project.inspect', app)).toEqual({
      type: 'project.inspected',
      requestId: REQUEST,
      inspection: {
        rootPath: app,
        name: 'app',
        hasConfig: false,
        configValid: false,
        scenarios: [],
      },
    });
  });

  it('lists the scenarios of a valid config and never a config value', async () => {
    const app = dir(home, 'app');
    write(path.join(app, 'demoflow.config.json'), CONFIG);
    write(
      path.join(app, 'demoflow', 'b.demo.json'),
      JSON.stringify({ ...JSON.parse(FIXTURE), name: 'Bee' }),
    );
    write(
      path.join(app, 'demoflow', 'a.demo.json'),
      JSON.stringify({ ...JSON.parse(FIXTURE), name: 'Ay' }),
    );
    const answer = await ask('project.inspect', app);
    expect(answer).toMatchObject({
      inspection: {
        hasConfig: true,
        configValid: true,
        scenarios: [
          { id: 'demoflow/a.demo.json', name: 'Ay' },
          { id: 'demoflow/b.demo.json', name: 'Bee' },
        ],
      },
    });
    const text = JSON.stringify(answer);
    expect(text).not.toContain('4123');
    expect(text).not.toContain('secret-dev-command');
    expect(text).not.toContain('baseUrl');
  });

  it('answers configValid false and no scenarios for a config that does not load', async () => {
    const app = dir(home, 'app');
    write(path.join(app, 'demoflow.config.json'), '{ "baseUrl": 7 }');
    write(path.join(app, 'demoflow', 'a.demo.json'), FIXTURE);
    expect(await ask('project.inspect', app)).toMatchObject({
      inspection: { hasConfig: true, configValid: false, scenarios: [] },
    });
  });

  it('fills githubUrl from the origin remote of the folder', async () => {
    const app = dir(home, 'app');
    write(
      path.join(app, '.git', 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(await ask('project.inspect', app)).toMatchObject({
      inspection: { githubUrl: 'https://github.com/acme/shop' },
    });
  });
});

describe('the GitHub URL', () => {
  it.each([
    ['https://github.com/acme/shop', 'https://github.com/acme/shop'],
    ['https://github.com/acme/shop.git', 'https://github.com/acme/shop'],
    ['git@github.com:acme/shop.git', 'https://github.com/acme/shop'],
    ['git@github.com:a.b-c/d_e', 'https://github.com/a.b-c/d_e'],
    ['ssh://git@github.com/acme/shop.git', 'https://github.com/acme/shop'],
  ])('reads %s', (remote, url) => {
    expect(githubUrlFrom(remote)).toBe(url);
  });

  it.each([
    'https://gitlab.com/acme/shop',
    'https://user:token@github.com/acme/shop.git',
    'https://token@github.com/acme/shop',
    'ssh://git@github.com:22/acme/shop',
    'git@github.com:acme/shop/extra',
    'https://github.com/acme',
    'https://github.com/../shop',
    'https://github.com.evil.test/acme/shop',
    'file:///srv/shop',
  ])('ignores %s', (remote) => {
    expect(githubUrlFrom(remote)).toBeUndefined();
  });

  it('reads the first url of [remote "origin"] only', () => {
    const config = [
      '[remote "upstream"]',
      '  url = https://github.com/other/shop',
      '[Remote "origin"]',
      '  URL = "https://github.com/acme/shop" ; a comment',
      '  url = https://github.com/acme/second',
      '[branch "main"]',
      '  url = https://github.com/never/this',
    ].join('\n');
    expect(originUrl(config)).toBe('https://github.com/acme/shop');
    expect(originUrl('[remote "Origin"]\nurl = x\n')).toBeUndefined();
  });

  it('never answers credentials from the config', async () => {
    const app = dir(home, 'app');
    write(
      path.join(app, '.git', 'config'),
      '[remote "origin"]\n\turl = https://ann:ghp_secret@github.com/acme/shop.git\n',
    );
    const answer = await ask('project.inspect', app);
    expect(answer).toMatchObject({ type: 'project.inspected' });
    expect(JSON.stringify(answer)).not.toContain('ghp_secret');
    expect(
      (answer.inspection as Record<string, unknown>).githubUrl,
    ).toBeUndefined();
  });

  it('follows a .git file to a gitdir inside an allowed root, and a worktree to its commondir', async () => {
    const main = dir(home, 'main');
    write(
      path.join(main, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/shop\n',
    );
    const worktreeDir = dir(main, '.git', 'worktrees', 'wt');
    write(path.join(worktreeDir, 'commondir'), '../..\n');
    const wt = dir(home, 'wt');
    write(path.join(wt, '.git'), `gitdir: ${worktreeDir}\n`);
    expect(await githubUrlOf(wt, [home], process.platform, nodeLaunchFs)).toBe(
      'https://github.com/acme/shop',
    );

    const sub = dir(main, 'sub');
    const modules = dir(main, '.git', 'modules', 'sub');
    write(
      path.join(modules, 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme/sub.git\n',
    );
    write(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(await githubUrlOf(sub, [home], process.platform, nodeLaunchFs)).toBe(
      'https://github.com/acme/sub',
    );
  });

  it('does not follow a gitdir outside the allowed roots', async () => {
    write(
      path.join(outside, 'repo', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/shop\n',
    );
    const app = dir(home, 'app');
    write(path.join(app, '.git'), `gitdir: ${path.join(outside, 'repo')}\n`);
    expect(
      await githubUrlOf(app, [home], process.platform, nodeLaunchFs),
    ).toBeUndefined();
  });

  it('ignores a config over 64 KiB', async () => {
    const app = dir(home, 'app');
    write(
      path.join(app, '.git', 'config'),
      `[remote "origin"]\n\turl = https://github.com/acme/shop\n${'#'.repeat(64 * 1024)}\n`,
    );
    expect(
      await githubUrlOf(app, [home], process.platform, nodeLaunchFs),
    ).toBeUndefined();
  });
});

describe('project.init', () => {
  it('creates both files in an empty allowed folder, then keeps them byte for byte', async () => {
    const app = dir(home, 'app');
    const first = await ask('project.init', app);
    expect(first).toMatchObject({
      type: 'project.initialised',
      requestId: REQUEST,
      created: ['demoflow.config.json', 'demoflow/first.demo.json'],
      kept: [],
      inspection: {
        rootPath: app,
        hasConfig: true,
        configValid: true,
        scenarios: [{ id: 'demoflow/first.demo.json', name: 'First demo' }],
      },
    });
    const config = readFileSync(path.join(app, 'demoflow.config.json'));
    const scenario = readFileSync(
      path.join(app, 'demoflow', 'first.demo.json'),
    );
    expect(JSON.parse(config.toString())).toEqual({
      baseUrl: 'http://localhost:3000',
    });

    const second = await ask('project.init', app);
    expect(second).toMatchObject({
      created: [],
      kept: ['demoflow.config.json', 'demoflow/first.demo.json'],
    });
    expect(readFileSync(path.join(app, 'demoflow.config.json'))).toEqual(
      config,
    );
    expect(readFileSync(path.join(app, 'demoflow', 'first.demo.json'))).toEqual(
      scenario,
    );
  });

  it('writes nothing outside the path rule', async () => {
    expect(await ask('project.init', outside)).toEqual(refused);
    expect(() =>
      readFileSync(path.join(outside, 'demoflow.config.json')),
    ).toThrow();
  });

  it('never writes through a linked demoflow/ folder', async () => {
    const app = dir(home, 'app');
    link(outside, path.join(app, 'demoflow'));
    expect(await ask('project.init', app)).toEqual({
      type: 'project.error',
      requestId: REQUEST,
      code: 'internal',
    });
    expect(() => readFileSync(path.join(outside, 'first.demo.json'))).toThrow();
  });
});

describe('project.register', () => {
  const ROOTS = () => ({
    allowedRootsFile: files().allowedRoots,
    websiteProjectsFile: files().websiteProjects,
    host,
    fs: nodeLaunchFs,
  });
  const checkDeps = () => ({
    indexFile: path.join(tmp, 'reported-runs.jsonl'),
    websiteRegistered: (rootPath: string) =>
      isWebsiteRegistered(rootPath, ROOTS()),
    fs: nodeLaunchFs,
    loadProject: loadProjectFor(host),
  });

  it('answers config-missing for a folder without config, config-invalid for a broken one', async () => {
    const app = dir(home, 'app');
    expect(await ask('project.register', app)).toEqual({
      type: 'project.error',
      requestId: REQUEST,
      code: 'config-missing',
    });
    write(path.join(app, 'demoflow.config.json'), '{');
    expect(await ask('project.register', app)).toEqual({
      type: 'project.error',
      requestId: REQUEST,
      code: 'config-invalid',
    });
    expect(await websiteRoots(files().websiteProjects)).toEqual(new Set());
  });

  it('registers the canonical root once, which checkProject then accepts until its root is disallowed', async () => {
    const work = dir(home, 'work');
    const app = dir(work, 'app');
    write(path.join(app, 'demoflow.config.json'), CONFIG);
    expect((await checkProject(app, checkDeps())).ok).toBe(false);

    expect(await ask('project.register', app)).toEqual({
      type: 'project.registered',
      requestId: REQUEST,
      rootPath: app,
    });
    await ask('project.register', `${app}${path.sep}`);
    const lines = readFileSync(files().websiteProjects, 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      rootPath: app,
      registeredAt: new Date(0).toISOString(),
    });
    expect(await checkProject(app, checkDeps())).toMatchObject({
      ok: true,
      root: app,
    });

    allowCommand(work, memoryIo(), commandDeps());
    expect((await checkProject(app, checkDeps())).ok).toBe(true);
    disallowCommand(work, memoryIo(), commandDeps());
    expect(await checkProject(app, checkDeps())).toEqual({
      ok: false,
      code: 'project-unknown',
    });
  });

  it('keeps the last 1,000 roots', () => {
    const file = files().websiteProjects;
    for (let i = 0; i < WEBSITE_PROJECTS_MAX; i++) {
      registerWebsiteProject(file, `/p/${i}`, 'at');
    }
    registerWebsiteProject(file, '/p/new', 'at');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(WEBSITE_PROJECTS_MAX);
    expect(lines[0]).toContain('/p/1"');
    expect(lines.at(-1)).toContain('/p/new');
  });
});

describe('one request at a time', () => {
  it('answers busy while one is in flight, and internal after 5 s', async () => {
    const app = dir(home, 'app');
    let release: (() => void) | undefined;
    const handler = requests({
      writeTemplate: () =>
        new Promise((resolve) => {
          release = () => resolve({ created: [], kept: [] });
        }),
    });
    const reply = {
      send: (message: Record<string, unknown>) => sent.push(message),
    };
    handler.handle({ type: 'project.init', requestId: 'a', path: app }, reply);
    await vi.waitFor(() => expect(release).toBeDefined());
    handler.handle(
      { type: 'project.inspect', requestId: 'b', path: app },
      reply,
    );
    expect(sent).toEqual([
      { type: 'project.error', requestId: 'b', code: 'busy' },
    ]);
    await clock.advance(PROJECT_REQUEST_MAX_MS);
    expect(sent).toContainEqual({
      type: 'project.error',
      requestId: 'a',
      code: 'internal',
    });
    // Still busy until the work itself ends; then answered once only.
    handler.handle(
      { type: 'project.inspect', requestId: 'c', path: app },
      reply,
    );
    expect(sent.at(-1)).toEqual({
      type: 'project.error',
      requestId: 'c',
      code: 'busy',
    });
    release?.();
    // Free once the late work ends; its answer is never sent.
    await vi.waitFor(async () => {
      expect(await ask('project.inspect', app, handler)).toMatchObject({
        type: 'project.inspected',
      });
    });
    expect(sent.filter((m) => m.requestId === 'a')).toHaveLength(1);
  });

  it('ignores a request without a request id and logs no path', async () => {
    const app = dir(home, 'secret-name');
    const handler = requests();
    handler.handle(
      { type: 'project.inspect', path: app },
      { send: (m) => sent.push(m) },
    );
    expect(sent).toEqual([]);
    await ask('project.inspect', app, handler);
    await ask('project.register', app, handler);
    expect(logger.text()).not.toContain('secret-name');
    expect(logger.text()).toContain(`project.inspect ${REQUEST}: answered`);
  });
});
