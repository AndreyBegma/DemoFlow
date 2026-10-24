import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDir as runDirFor } from '../../src/config/index.ts';
import {
  type ChildExit,
  type RunChild,
  type SpawnRun,
  type SpawnRunOptions,
  spawnNode,
} from '../../src/mcp/child.ts';
import { type LaunchFs, nodeLaunchFs } from '../../src/runner/launch/checks.ts';
import {
  LAUNCH_KILL_GRACE_MS,
  LAUNCH_MAX_MS,
  Launcher,
  type LauncherDeps,
  loadProjectFor,
} from '../../src/runner/launch/index.ts';
import {
  LIST_MAX_FRAME_BYTES,
  LIST_MAX_SCENARIOS,
  listedFrame,
} from '../../src/runner/launch/list.ts';
import { isScenarioId } from '../../src/runner/launch/scenario-id.ts';
import { isAlive } from '../../src/runner/lock.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { FakeClock, memoryLogger } from './fakes.ts';

const FIXTURE = readFileSync(
  path.join(
    import.meta.dirname,
    '../../../fixture/demoflow/customers.demo.json',
  ),
  'utf8',
);
const TREE_CHILD = path.join(import.meta.dirname, 'tree-child.ts');
const REQUEST = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';

function scenario(name: string): string {
  return JSON.stringify({ ...JSON.parse(FIXTURE), name });
}

/** Can this machine make a file symlink? Windows needs a privilege for it. */
function canLinkFiles(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'demoflow-link-'));
  try {
    writeFileSync(path.join(dir, 'a'), '');
    symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const FILE_LINKS = canLinkFiles();

interface Spawned {
  args: string[];
  cwd: string;
  options: SpawnRunOptions | undefined;
  child: RunChild;
  killed: number;
  exit(code?: number | null): void;
  /** The child prints these lines on stdout. */
  print(...lines: string[]): void;
}

function fakeSpawn(): { spawn: SpawnRun; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: SpawnRun = (args, cwd, options) => {
    let resolve: (exit: ChildExit) => void = () => {};
    const exited = new Promise<ChildExit>((r) => {
      resolve = r;
    });
    const call: Spawned = {
      args,
      cwd,
      options,
      killed: 0,
      exit: (code = 0) => resolve({ code, stderrTail: '' }),
      print: (...lines) => {
        for (const line of lines) options?.onStdoutLine?.(line);
      },
      child: {
        pid: 4242,
        exited,
        kill: async () => {
          call.killed++;
          resolve({ code: null, stderrTail: '' });
          await exited;
        },
      },
    };
    calls.push(call);
    return call.child;
  };
  return { spawn, calls };
}

function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: (message: Record<string, unknown>) => sent.push(message),
  };
}

let tmp: string;
let root: string;
let home: string;
let indexFile: string;
let clock: FakeClock;
let logger: ReturnType<typeof memoryLogger>;
let spawned: ReturnType<typeof fakeSpawn>;
let reply: ReturnType<typeof recorder>;
let current: ReturnType<typeof recorder>;
let env: Record<string, string | undefined>;
let statuses: Map<string, string>;

function write(relative: string, text: string): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function register(rootPath = root): void {
  appendReportedRun(indexFile, {
    id: 'srv-0',
    runDir: path.join(home, 'runs', 'old'),
    at: '2026-10-23T10:00:00.000Z',
    root: rootPath,
  });
}

function launcher(overrides: Partial<LauncherDeps> = {}): Launcher {
  return new Launcher({
    indexFile,
    fs: nodeLaunchFs,
    logger,
    clock,
    platform: process.platform,
    env,
    spawn: spawned.spawn,
    loadProject: () => ({ ok: true, home }),
    newRunId: () => 'local-1',
    readStatus: async (runDir) => {
      const status = statuses.get(runDir);
      if (status === undefined) throw new Error('no result.json');
      return status;
    },
    ...overrides,
  });
}

function send(target: Launcher, message: Record<string, unknown>): void {
  target.handle(message, reply, current);
}

const listOf = (rootPath = root) => ({
  type: 'scenarios.list',
  requestId: REQUEST,
  rootPath,
});
const startOf = (scenarioId: string, rootPath = root) => ({
  type: 'run.start',
  requestId: REQUEST,
  rootPath,
  scenarioId,
});

async function answered(
  count = 1,
  timeout?: number,
): Promise<Record<string, unknown>> {
  await vi.waitFor(
    () => expect(reply.sent.length).toBeGreaterThanOrEqual(count),
    timeout === undefined ? undefined : { timeout },
  );
  return reply.sent[count - 1] as Record<string, unknown>;
}

beforeEach(() => {
  tmp = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-launch-')),
  );
  root = path.join(tmp, 'shop');
  home = path.join(tmp, 'home');
  indexFile = path.join(tmp, 'config', 'reported-runs.jsonl');
  mkdirSync(root);
  write('demoflow.config.json', '{"baseUrl":"http://localhost:1"}');
  clock = new FakeClock();
  logger = memoryLogger();
  spawned = fakeSpawn();
  reply = recorder();
  current = recorder();
  env = {};
  statuses = new Map();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('the scenario id rule', () => {
  it.each([
    'demoflow/a.demo.json',
    'demoflow/nested/deep/b.demo.json',
    'demoflow/with space é.demo.json',
  ])('accepts %s', (id) => {
    expect(isScenarioId(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['outside demoflow/', 'other/a.demo.json'],
    ['the wrong suffix', 'demoflow/a.json'],
    ['..', 'demoflow/../a.demo.json'],
    ['.', 'demoflow/./a.demo.json'],
    ['an empty segment', 'demoflow//a.demo.json'],
    ['a backslash', 'demoflow\\a.demo.json'],
    ['a colon', 'demoflow/c:a.demo.json'],
    ['an absolute path', '/demoflow/a.demo.json'],
    ['a control character', 'demoflow/a\u0000.demo.json'],
    ['DEL', 'demoflow/a\u007f.demo.json'],
    ['256 characters', `demoflow/${'a'.repeat(237)}.demo.json`],
    ['not a string', 42],
  ])('refuses %s', (_why, id) => {
    expect(isScenarioId(id)).toBe(false);
  });
});

describe('scenarios.list', () => {
  it('lists valid scenarios sorted by id, counts the invalid, and nothing outside demoflow/', async () => {
    register();
    write('demoflow/b.demo.json', scenario('Bee'));
    write('demoflow/a.demo.json', scenario('Ay'));
    write('demoflow/nested/deep/c.demo.json', scenario('Sea'));
    write('demoflow/broken.demo.json', '{nope');
    write('demoflow/not-a-scenario.demo.json', '{"name":"x"}');
    write('demoflow/notes.json', scenario('Ignored'));
    write('other/d.demo.json', scenario('Outside'));
    write('e.demo.json', scenario('Root'));
    send(launcher(), listOf());
    expect(await answered()).toEqual({
      type: 'scenarios.listed',
      requestId: REQUEST,
      scenarios: [
        { id: 'demoflow/a.demo.json', name: 'Ay' },
        { id: 'demoflow/b.demo.json', name: 'Bee' },
        { id: 'demoflow/nested/deep/c.demo.json', name: 'Sea' },
      ],
      truncated: false,
      skipped: 2,
    });
    expect(logger.text()).toMatch(/scenarios\.list .+: listed 3 \(2 skipped\)/);
  });

  it('answers an empty list when there is no demoflow/ folder', async () => {
    register();
    send(launcher(), listOf());
    expect(await answered()).toMatchObject({
      scenarios: [],
      truncated: false,
      skipped: 0,
    });
  });

  it('keeps the first 100 and says it truncated', async () => {
    register();
    for (let i = 0; i < LIST_MAX_SCENARIOS + 5; i++) {
      write(
        `demoflow/s${String(i).padStart(3, '0')}.demo.json`,
        scenario(`S${i}`),
      );
    }
    send(launcher(), listOf());
    // Listing and parsing 105 files outlasts the 1 s default on the Windows runner.
    const frame = await answered(1, 10_000);
    const scenarios = frame.scenarios as Array<{ id: string }>;
    expect(scenarios).toHaveLength(LIST_MAX_SCENARIOS);
    expect(scenarios[0]?.id).toBe('demoflow/s000.demo.json');
    expect(scenarios.at(-1)?.id).toBe('demoflow/s099.demo.json');
    expect(frame.truncated).toBe(true);
  }, 15_000);

  it('cuts names to 200 characters', async () => {
    register();
    write('demoflow/long.demo.json', scenario('n'.repeat(300)));
    send(launcher(), listOf());
    const frame = await answered();
    expect((frame.scenarios as Array<{ name: string }>)[0]?.name).toBe(
      'n'.repeat(200),
    );
  });

  it('drops entries from the end until the frame is at most 60,000 bytes', () => {
    const scenarios = Array.from({ length: LIST_MAX_SCENARIOS }, (_, i) => ({
      id: `demoflow/${String(i).padStart(3, '0')}${'x'.repeat(230)}.demo.json`,
      name: '€'.repeat(200),
    }));
    const frame = listedFrame(REQUEST, {
      scenarios,
      truncated: false,
      skipped: 1,
    });
    const kept = frame.scenarios as unknown[];
    expect(
      Buffer.byteLength(JSON.stringify(frame), 'utf8'),
    ).toBeLessThanOrEqual(LIST_MAX_FRAME_BYTES);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(LIST_MAX_SCENARIOS);
    expect(kept).toEqual(scenarios.slice(0, kept.length));
    expect(frame).toMatchObject({ truncated: true, skipped: 1 });
  });

  it('leaves a frame that fits alone', () => {
    const scenarios = [{ id: 'demoflow/a.demo.json', name: 'A' }];
    expect(
      listedFrame(REQUEST, { scenarios, truncated: false, skipped: 0 }),
    ).toMatchObject({ scenarios, truncated: false });
  });

  it.skipIf(!FILE_LINKS)(
    'never lists a linked file or enters a linked directory (skipped on Windows without the symlink privilege)',
    async () => {
      register();
      const outside = path.join(tmp, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'x.demo.json'), scenario('Outside'));
      write('demoflow/a.demo.json', scenario('Ay'));
      symlinkSync(
        path.join(outside, 'x.demo.json'),
        path.join(root, 'demoflow', 'link.demo.json'),
      );
      symlinkSync(outside, path.join(root, 'demoflow', 'dir'), 'junction');
      send(launcher(), listOf());
      expect(await answered()).toMatchObject({
        scenarios: [{ id: 'demoflow/a.demo.json', name: 'Ay' }],
        skipped: 0,
      });
    },
  );
});

describe('the project check', () => {
  /** Records every path read below the root. */
  function spyFs(): { fs: LaunchFs; read: string[] } {
    const read: string[] = [];
    return {
      read,
      fs: {
        ...nodeLaunchFs,
        readdir: (dir) => {
          read.push(dir);
          return nodeLaunchFs.readdir(dir);
        },
        readFile: (file, max) => {
          read.push(file);
          return nodeLaunchFs.readFile(file, max);
        },
      },
    };
  }

  beforeEach(() => {
    write('demoflow/a.demo.json', scenario('Ay'));
  });

  const cases: Array<[string, () => void]> = [
    ['an unregistered root', () => register(path.join(tmp, 'elsewhere'))],
    [
      'a root that is now a link',
      () => {
        register();
        renameSync(root, `${root}-real`);
        symlinkSync(`${root}-real`, root, 'junction');
      },
    ],
    [
      'a root without demoflow.config.json',
      () => {
        register();
        rmSync(path.join(root, 'demoflow.config.json'));
      },
    ],
  ];

  it.each(
    cases,
  )('answers project-unknown to a list for %s, reading nothing below it', async (_why, arrange) => {
    arrange();
    const spy = spyFs();
    send(launcher({ fs: spy.fs }), listOf());
    expect(await answered()).toEqual({
      type: 'scenarios.error',
      requestId: REQUEST,
      code: 'project-unknown',
    });
    expect(spy.read).toEqual([]);
  });

  it.each(
    cases,
  )('answers project-unknown to a start for %s, spawning nothing', async (_why, arrange) => {
    arrange();
    const spy = spyFs();
    send(launcher({ fs: spy.fs }), startOf('demoflow/a.demo.json'));
    expect(await answered()).toEqual({
      type: 'run.error',
      requestId: REQUEST,
      code: 'project-unknown',
    });
    expect(spy.read).toEqual([]);
    expect(spawned.calls).toEqual([]);
  });

  it('needs the exact string: a registered root with a trailing separator is not it', async () => {
    register();
    send(launcher(), listOf(`${root}${path.sep}`));
    expect(await answered()).toMatchObject({ code: 'project-unknown' });
  });

  it('answers config-invalid to a start and project-unknown to a list for a broken config', async () => {
    register();
    write('demoflow.config.json', '{"baseUrl":42}');
    const host = {
      platform: process.platform,
      env: { XDG_CONFIG_HOME: path.join(tmp, 'xdg'), APPDATA: tmp },
      homedir: tmp,
    };
    const real = launcher({ loadProject: loadProjectFor(host) });
    send(real, startOf('demoflow/a.demo.json'));
    expect(await answered()).toMatchObject({
      type: 'run.error',
      code: 'config-invalid',
    });
    send(real, listOf());
    expect(await answered(2)).toMatchObject({
      type: 'scenarios.error',
      code: 'project-unknown',
    });
    expect(spawned.calls).toEqual([]);
  });
});

describe('run.start', () => {
  beforeEach(() => {
    register();
    write('demoflow/nested/a.demo.json', scenario('Create a customer'));
  });

  it('spawns exactly demoflow run of the checked file, in the root, with a 15 s kill grace', async () => {
    send(launcher(), startOf('demoflow/nested/a.demo.json'));
    expect(await answered()).toEqual({
      type: 'run.started',
      requestId: REQUEST,
      scenarioName: 'Create a customer',
    });
    expect(spawned.calls).toHaveLength(1);
    const [call] = spawned.calls;
    expect(call?.args).toEqual([
      'run',
      path.join(root, 'demoflow', 'nested', 'a.demo.json'),
      '--json',
      '--progress',
      '--run-id',
      'local-1',
      '--project',
      root,
    ]);
    expect(call?.cwd).toBe(root);
    expect(call?.options).toEqual({
      killGraceMs: LAUNCH_KILL_GRACE_MS,
      onStdoutLine: expect.any(Function),
    });
    expect(LAUNCH_KILL_GRACE_MS).toBe(15_000);
  });

  it.each([
    ['..', 'demoflow/../demoflow.config.json'],
    ['a backslash', 'demoflow\\nested\\a.demo.json'],
    ['an absolute path', '<root>/demoflow/nested/a.demo.json'],
    ['outside demoflow/', 'other/a.demo.json'],
    ['a missing file', 'demoflow/none.demo.json'],
    ['a directory', 'demoflow/nested.demo.json'],
  ])('answers scenario-not-found to %s and spawns nothing', async (_why, id) => {
    write('other/a.demo.json', scenario('Outside'));
    mkdirSync(path.join(root, 'demoflow', 'nested.demo.json'));
    send(
      launcher(),
      startOf(
        id.startsWith('<root>')
          ? path.join(root, ...id.slice('<root>/'.length).split('/'))
          : id,
      ),
    );
    expect(await answered()).toEqual({
      type: 'run.error',
      requestId: REQUEST,
      code: 'scenario-not-found',
    });
    expect(spawned.calls).toEqual([]);
  });

  it.skipIf(!FILE_LINKS)(
    'answers scenario-not-found to a linked file and to a file under a linked directory (skipped on Windows without the symlink privilege)',
    async () => {
      const outside = path.join(tmp, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'x.demo.json'), scenario('Outside'));
      symlinkSync(
        path.join(outside, 'x.demo.json'),
        path.join(root, 'demoflow', 'link.demo.json'),
      );
      symlinkSync(outside, path.join(root, 'demoflow', 'dir'), 'junction');
      const target = launcher();
      send(target, startOf('demoflow/link.demo.json'));
      expect(await answered()).toMatchObject({ code: 'scenario-not-found' });
      send(target, startOf('demoflow/dir/x.demo.json'));
      expect(await answered(2)).toMatchObject({ code: 'scenario-not-found' });
      expect(spawned.calls).toEqual([]);
    },
  );

  it.each([
    ['not JSON', '{nope'],
    ['not a scenario', '{"name":"x"}'],
    ['over 1 MiB', ' '.repeat(1024 * 1024 + 1)],
  ])('answers scenario-invalid to a file that is %s', async (_why, text) => {
    write('demoflow/bad.demo.json', text);
    send(launcher(), startOf('demoflow/bad.demo.json'));
    expect(await answered()).toMatchObject({ code: 'scenario-invalid' });
    expect(spawned.calls).toEqual([]);
  });

  it('answers busy to a second start while one runs, and spawns once', async () => {
    const target = launcher();
    send(target, startOf('demoflow/nested/a.demo.json'));
    // The second arrives while the first is still in its checks.
    target.handle(
      { ...startOf('demoflow/nested/a.demo.json'), requestId: 'second' },
      reply,
      current,
    );
    await answered(2);
    expect(reply.sent).toContainEqual({
      type: 'run.error',
      requestId: 'second',
      code: 'busy',
    });
    send(target, {
      ...startOf('demoflow/nested/a.demo.json'),
      requestId: 'third',
    });
    expect(await answered(3)).toMatchObject({
      requestId: 'third',
      code: 'busy',
    });
    expect(spawned.calls).toHaveLength(1);
  });

  it.each([
    { CI: 'true' },
    { DEMOFLOW_NO_REPORT: '1' },
  ])('answers reporting-off with %j in the daemon environment', async (extra) => {
    env = extra;
    send(launcher(), startOf('demoflow/nested/a.demo.json'));
    expect(await answered()).toMatchObject({ code: 'reporting-off' });
    expect(spawned.calls).toEqual([]);
  });

  it('appends --format once per chosen format, in order, after --project', async () => {
    send(launcher(), {
      ...startOf('demoflow/nested/a.demo.json'),
      options: { formats: ['gif', 'mp4-vertical'] },
    });
    await answered();
    expect(spawned.calls[0]?.args).toEqual([
      'run',
      path.join(root, 'demoflow', 'nested', 'a.demo.json'),
      '--json',
      '--progress',
      '--run-id',
      'local-1',
      '--project',
      root,
      '--format',
      'gif',
      '--format',
      'mp4-vertical',
    ]);
    expect(logger.text()).toContain('started run local-1, formats 2');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'mp4'],
    ['an unknown key', { formats: ['mp4'], headed: true }],
    ['a base url', { formats: ['mp4'], baseUrl: 'https://x' }],
    ['no formats', {}],
    ['empty formats', { formats: [] }],
    ['a repeat', { formats: ['mp4', 'mp4'] }],
    ['an unknown format', { formats: ['mov'] }],
  ])('answers options-invalid to %s, spawns nothing and leaves no launch', async (_why, options) => {
    const target = launcher();
    send(target, { ...startOf('demoflow/nested/a.demo.json'), options });
    expect(await answered()).toEqual({
      type: 'run.error',
      requestId: REQUEST,
      code: 'options-invalid',
    });
    expect(spawned.calls).toEqual([]);
    expect(logger.text()).toContain('refused options-invalid');
    send(target, startOf('demoflow/nested/a.demo.json'));
    expect(await answered(2)).toMatchObject({ type: 'run.started' });
  });

  it('reads no project file for invalid options', async () => {
    const loads: string[] = [];
    send(
      launcher({
        loadProject: (rootPath) => {
          loads.push(rootPath);
          return { ok: true, home };
        },
      }),
      {
        ...startOf('demoflow/nested/a.demo.json'),
        options: { headed: true },
      },
    );
    await answered();
    expect(loads).toEqual([]);
  });

  it('answers reporting-off and busy before options-invalid', async () => {
    env = { CI: 'true' };
    const bad = { formats: ['mov'] };
    send(launcher(), {
      ...startOf('demoflow/nested/a.demo.json'),
      options: bad,
    });
    expect(await answered()).toMatchObject({ code: 'reporting-off' });

    env = {};
    const target = launcher();
    send(target, startOf('demoflow/nested/a.demo.json'));
    send(target, {
      ...startOf('demoflow/nested/a.demo.json'),
      requestId: 'second',
      options: bad,
    });
    // The busy refusal is synchronous; run.started follows the first start's checks.
    expect(await answered(2)).toMatchObject({
      requestId: 'second',
      code: 'busy',
    });
  });

  it('answers io when the child cannot be spawned', async () => {
    const spawn: SpawnRun = () => ({
      pid: undefined,
      exited: Promise.resolve({ code: null, stderrTail: 'ENOENT' }),
      kill: async () => {},
    });
    send(launcher({ spawn }), startOf('demoflow/nested/a.demo.json'));
    expect(await answered()).toMatchObject({ type: 'run.error', code: 'io' });
  });

  it('ignores a start without the fields it needs', async () => {
    const target = launcher();
    send(target, { type: 'run.start', requestId: REQUEST, rootPath: root });
    send(target, { type: 'scenarios.list', requestId: 7, rootPath: root });
    send(target, { type: 'run.cancel' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reply.sent).toEqual([]);
    expect(logger.text()).toMatch(/ignored a malformed run\.start/);
    expect(logger.text()).toMatch(/ignored a malformed scenarios\.list/);
    expect(logger.text()).toMatch(/ignored a malformed run\.cancel/);
  });

  it('logs no path and no scenario id', async () => {
    const target = launcher();
    send(target, startOf('demoflow/nested/a.demo.json'));
    await answered();
    send(target, startOf('demoflow/none.demo.json'));
    await answered(2);
    send(target, listOf());
    await answered(3);
    spawned.calls[0]?.exit(0);
    await vi.waitFor(() => expect(current.sent).toHaveLength(1));
    const text = logger.text();
    expect(text).toMatch(/refused busy/);
    expect(text).toMatch(/started run local-1/);
    expect(text).not.toContain(tmp);
    expect(text).not.toContain('a.demo.json');
    expect(text).not.toContain('demoflow/');
  });
});

describe('a running launch', () => {
  const runDir = () => runDirFor(home, 'local-1', process.platform);

  beforeEach(() => {
    register();
    write('demoflow/a.demo.json', scenario('Ay'));
  });

  async function started(target: Launcher): Promise<Spawned> {
    send(target, startOf('demoflow/a.demo.json'));
    expect(await answered()).toMatchObject({ type: 'run.started' });
    const call = spawned.calls[0];
    if (call === undefined) throw new Error('nothing spawned');
    return call;
  }

  async function finished(): Promise<Record<string, unknown>> {
    await vi.waitFor(() => expect(current.sent).toHaveLength(1));
    return current.sent[0] as Record<string, unknown>;
  }

  it('is cancelled by run.cancel with its request id: killed, finished cancelled, no run id', async () => {
    const target = launcher();
    const call = await started(target);
    send(target, { type: 'run.cancel', requestId: REQUEST });
    expect(await finished()).toEqual({
      type: 'run.finished',
      requestId: REQUEST,
      outcome: 'cancelled',
      runId: null,
    });
    expect(call.killed).toBe(1);
  });

  it('ignores a run.cancel for another launch', async () => {
    const target = launcher();
    const call = await started(target);
    send(target, { type: 'run.cancel', requestId: 'other' });
    expect(call.killed).toBe(0);
    expect(logger.text()).toMatch(/ignored a run\.cancel for other/);
    call.exit(0);
    await finished();
  });

  it('never spawns when cancelled while its checks run', async () => {
    const target = launcher();
    send(target, startOf('demoflow/a.demo.json'));
    send(target, { type: 'run.cancel', requestId: REQUEST });
    await vi.waitFor(() =>
      expect(logger.text()).toMatch(/cancelled before start/),
    );
    expect(spawned.calls).toEqual([]);
    expect(reply.sent).toEqual([]);
  });

  it('is killed after 15 minutes and ends timed-out', async () => {
    const target = launcher();
    const call = await started(target);
    await clock.advance(LAUNCH_MAX_MS - 1);
    expect(call.killed).toBe(0);
    await clock.advance(1);
    expect(await finished()).toMatchObject({
      outcome: 'timed-out',
      runId: null,
    });
    expect(call.killed).toBe(1);
  });

  it('sends passed with the server run id when the child exits on its own', async () => {
    const target = launcher();
    const call = await started(target);
    statuses.set(runDir(), 'completed');
    appendReportedRun(indexFile, {
      id: 'srv-9',
      runDir: runDir(),
      at: '2026-10-23T10:01:00.000Z',
      root,
    });
    call.exit(0);
    expect(await finished()).toEqual({
      type: 'run.finished',
      requestId: REQUEST,
      outcome: 'passed',
      runId: 'srv-9',
    });
    // The next start is no longer busy.
    send(target, { ...startOf('demoflow/a.demo.json'), requestId: 'next' });
    expect(await answered(2)).toMatchObject({ type: 'run.started' });
  });

  it('sends failed with a null run id for a failed run that was not reported', async () => {
    const call = await started(launcher());
    statuses.set(runDir(), 'failed');
    call.exit(1);
    expect(await finished()).toMatchObject({ outcome: 'failed', runId: null });
  });

  it('sends failed when there is no result.json', async () => {
    const call = await started(launcher());
    call.exit(1);
    expect(await finished()).toMatchObject({ outcome: 'failed', runId: null });
  });

  it('is announced by running() once its child is spawned, and not before', async () => {
    const target = launcher();
    expect(target.running()).toEqual([]);
    send(target, startOf('demoflow/a.demo.json'));
    // Still in its checks: nothing to reattach.
    expect(target.running()).toEqual([]);
    expect(await answered()).toMatchObject({ type: 'run.started' });
    expect(target.running()).toEqual([REQUEST]);
    spawned.calls[0]?.exit(0);
    await finished();
    expect(target.running()).toEqual([]);
  });

  it('is still announced while its child is being killed', async () => {
    const target = launcher();
    const call = await started(target);
    call.child.kill = () => new Promise<void>(() => {});
    send(target, { type: 'run.cancel', requestId: REQUEST });
    expect(target.running()).toEqual([REQUEST]);
  });

  it('is not announced when its request id is not a UUID v4, and the log says so', async () => {
    const target = launcher();
    const id = 'not-a-uuid';
    target.handle(
      { ...startOf('demoflow/a.demo.json'), requestId: id },
      reply,
      current,
    );
    expect(await answered()).toMatchObject({ type: 'run.started' });
    expect(target.running()).toEqual([]);
    expect(logger.text()).toMatch(
      /not announced, the request id is not a UUID v4/,
    );
  });

  it('sends one run.finished cancelled for two run.cancel frames', async () => {
    const target = launcher();
    const call = await started(target);
    send(target, { type: 'run.cancel', requestId: REQUEST });
    send(target, { type: 'run.cancel', requestId: REQUEST });
    await finished();
    await clock.advance(0);
    expect(current.sent).toEqual([
      {
        type: 'run.finished',
        requestId: REQUEST,
        outcome: 'cancelled',
        runId: null,
      },
    ]);
    expect(call.killed).toBeGreaterThanOrEqual(1);
  });

  it('is cancelled by close(), which resolves once the child is gone', async () => {
    const target = launcher();
    const call = await started(target);
    await target.close();
    expect(call.killed).toBe(1);
    expect(current.sent).toMatchObject([{ outcome: 'cancelled' }]);
    send(target, { ...startOf('demoflow/a.demo.json'), requestId: 'late' });
    expect(await answered(2)).toMatchObject({ code: 'io' });
  });
});

describe('a cancelled run with a real process tree', () => {
  it('leaves neither the child nor its grandchild alive', async () => {
    register();
    write('demoflow/a.demo.json', scenario('Ay'));
    const pidFile = path.join(tmp, 'pids.json');
    const spawn: SpawnRun = (_args, cwd, options) =>
      spawnNode(TREE_CHILD, [pidFile], cwd, options);
    const target = launcher({ spawn });
    send(target, startOf('demoflow/a.demo.json'));
    expect(await answered()).toMatchObject({ type: 'run.started' });
    let pids: { child: number; grandchild: number } | undefined;
    await vi.waitFor(
      () => {
        pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      },
      { timeout: 15_000, interval: 50 },
    );
    if (pids === undefined) throw new Error('no pids');
    expect(isAlive(pids.child)).toBe(true);
    expect(isAlive(pids.grandchild)).toBe(true);
    send(target, { type: 'run.cancel', requestId: REQUEST });
    await vi.waitFor(() => expect(current.sent).toHaveLength(1), {
      timeout: 30_000,
      interval: 50,
    });
    expect(current.sent[0]).toMatchObject({ outcome: 'cancelled' });
    const { child, grandchild } = pids;
    // `taskkill /T` on Windows may land a moment after the child is gone.
    await vi.waitFor(
      () => {
        expect(isAlive(child)).toBe(false);
        expect(isAlive(grandchild)).toBe(false);
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});

const STDOUT_CHILD = path.join(import.meta.dirname, 'stdout-child.ts');

describe('spawnNode stdout lines', () => {
  it('delivers lines split across chunks, strips CRLF and drops a 9 KiB line only', async () => {
    const lines: string[] = [];
    const child = spawnNode(STDOUT_CHILD, [], tmp, {
      onStdoutLine: (line) => {
        lines.push(line);
      },
    });
    await child.exited;
    expect(lines).toEqual([
      '{"type":"progress","phase":"app"}',
      'second',
      'third',
      'last',
    ]);
  });

  it('keeps reading when the callback throws', async () => {
    const lines: string[] = [];
    const child = spawnNode(STDOUT_CHILD, [], tmp, {
      onStdoutLine: (line) => {
        lines.push(line);
        throw new Error('boom');
      },
    });
    await child.exited;
    expect(lines).toHaveLength(4);
  });

  it('discards stdout without a callback, as before', async () => {
    const child = spawnNode(STDOUT_CHILD, [], tmp);
    expect(await child.exited).toMatchObject({ code: 0 });
  });
});

describe('run.progress', () => {
  const runDir = () => runDirFor(home, 'local-1', process.platform);
  const line = (progress: Record<string, unknown>) =>
    JSON.stringify({ type: 'progress', ...progress });

  beforeEach(() => {
    register();
    write('demoflow/a.demo.json', scenario('Ay'));
  });

  async function started(target: Launcher): Promise<Spawned> {
    send(target, startOf('demoflow/a.demo.json'));
    expect(await answered()).toMatchObject({ type: 'run.started' });
    const call = spawned.calls[0];
    if (call === undefined) throw new Error('nothing spawned');
    return call;
  }

  it('sends the first progress at once, then only the latest once a second is up', async () => {
    const call = await started(launcher());
    call.print(
      line({ phase: 'app' }),
      line({ phase: 'steps', step: 1, steps: 3 }),
      line({ phase: 'steps', step: 2, steps: 3 }),
      line({ phase: 'steps', step: 3, steps: 3 }),
    );
    expect(current.sent).toEqual([
      {
        type: 'run.progress',
        requestId: REQUEST,
        phase: 'app',
        step: null,
        steps: null,
      },
    ]);
    await clock.advance(999);
    expect(current.sent).toHaveLength(1);
    await clock.advance(1);
    expect(current.sent[1]).toEqual({
      type: 'run.progress',
      requestId: REQUEST,
      phase: 'steps',
      step: 3,
      steps: 3,
    });
    expect(current.sent).toHaveLength(2);
  });

  it('sends nothing for output that is not progress', async () => {
    const call = await started(launcher());
    call.print(
      'garbage',
      '{"status":"completed"}',
      line({ phase: 'steps', step: 0, steps: 2 }),
      line({ phase: 'steps', step: 3, steps: 2 }),
      line({ phase: 'steps', step: 1, steps: 10_001 }),
      line({ phase: 'app', step: 1, steps: 2 }),
      line({ phase: 'nope' }),
      JSON.stringify({ type: 'other', phase: 'app' }),
    );
    await clock.advance(5_000);
    expect(current.sent).toEqual([]);
  });

  it('runs the launch through: frames in order, then run.finished, nothing after', async () => {
    const call = await started(launcher());
    call.print(line({ phase: 'app' }));
    await clock.advance(1_000);
    call.print(line({ phase: 'steps', step: 1, steps: 2 }));
    await clock.advance(1_000);
    call.print(line({ phase: 'steps', step: 2, steps: 2 }));
    call.print(line({ phase: 'rendering' }));
    statuses.set(runDir(), 'completed');
    call.exit(0);
    await vi.waitFor(() =>
      expect(current.sent.at(-1)).toMatchObject({ type: 'run.finished' }),
    );
    await clock.advance(5_000);
    expect(current.sent.map((m) => [m.type, m.phase, m.step])).toEqual([
      ['run.progress', 'app', null],
      ['run.progress', 'steps', 1],
      ['run.progress', 'steps', 2],
      ['run.finished', undefined, undefined],
    ]);
  });
});
