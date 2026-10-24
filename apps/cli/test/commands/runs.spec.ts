import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lutimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../../src/commands/io.ts';
import {
  type RunsDeps,
  runsDeleteCommand,
  runsListCommand,
  runsPruneCommand,
} from '../../src/commands/runs.ts';
import {
  formatSize,
  nodeRunsFs,
  parseDuration,
  type RunsFs,
  type RunsStat,
} from '../../src/commands/runs-scan.ts';
import { type HostEnvironment, osDataDir } from '../../src/config/index.ts';
import { main } from '../../src/main.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { locateVideo, nodeRelayFs } from '../../src/runner/relay/index.ts';
import {
  appendReportedRun,
  findReportedRun,
} from '../../src/runs-report/reported-runs.ts';
import { memoryLogger } from '../runner/fakes.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let dir: string;
let home: string;
let runs: string;
let outside: string;
let host: HostEnvironment;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-runs-')));
  home = path.join(dir, 'home');
  runs = path.join(home, 'runs');
  outside = path.join(dir, 'outside');
  host = {
    platform: process.platform,
    env: { DEMOFLOW_HOME: home },
    homedir: path.join(dir, 'user'),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<RunsDeps> = {}): RunsDeps {
  return { host, cwd: dir, now: () => NOW, fs: nodeRunsFs, ...overrides };
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A directory link that needs no privilege on Windows (a junction). */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function capture(): Io & { out: string; err: string } {
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
  return io;
}

function result(
  runId: string,
  startedAt: number,
  status: 'completed' | 'running' = 'completed',
): string {
  const passed = { status: 'passed' };
  return JSON.stringify({
    schemaVersion: 1,
    runId,
    scenarioId: 'demoflow/login.demo.json',
    scenarioName: `Scenario ${runId}`,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(startedAt).toISOString(),
    status,
    stages: {
      readiness: passed,
      execution: passed,
      verification: passed,
      recording: status === 'running' ? { status: 'running' } : passed,
      rendering: { status: 'skipped' },
      storage: { status: 'skipped' },
    },
    renders: [
      {
        renderer: 'ffmpeg',
        format: 'mp4',
        file: 'render/ffmpeg.mp4',
        durationMs: 1000,
        sizeBytes: 10,
        width: 640,
        height: 360,
        fps: 30,
      },
    ],
    warnings: [],
  });
}

/** Sets the mtime of `target` and everything under it, never following links. */
async function age(target: string, at: number): Promise<void> {
  const stat = lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of readdirSync(target)) {
      await age(path.join(target, name), at);
    }
  }
  const time = new Date(at);
  if (stat.isSymbolicLink()) {
    await lutimes(target, time, time);
  } else {
    utimesSync(target, time, time);
  }
}

const OLD = 'old-settled';
const NEW = 'new-settled';
const SCENARIO_ONLY = 'partial-scenario';
const RUNNING = 'partial-running';
const ACTIVE = 'active-run';

/**
 * Settled runs 60 and 2 days old, partial runs 45 (only `scenario.json`) and
 * 10 days old (`status: running`), an active run started 90 days ago but
 * touched now, and entries that are not runs.
 */
async function seed(): Promise<void> {
  write(path.join(runs, OLD, 'result.json'), result(OLD, NOW - 60 * DAY));
  write(path.join(runs, OLD, 'render', 'ffmpeg.mp4'), 'x'.repeat(2048));
  await age(path.join(runs, OLD), NOW - 60 * DAY);

  write(path.join(runs, NEW, 'result.json'), result(NEW, NOW - 2 * DAY));
  await age(path.join(runs, NEW), NOW - 2 * DAY);

  write(path.join(runs, SCENARIO_ONLY, 'scenario.json'), '{}');
  await age(path.join(runs, SCENARIO_ONLY), NOW - 45 * DAY);

  write(
    path.join(runs, RUNNING, 'result.json'),
    result(RUNNING, NOW - 10 * DAY, 'running'),
  );
  await age(path.join(runs, RUNNING), NOW - 10 * DAY);

  write(path.join(runs, ACTIVE, 'result.json'), result(ACTIVE, NOW - 90 * DAY));
  await age(path.join(runs, ACTIVE), NOW - 90 * DAY);
  write(path.join(runs, ACTIVE, 'source.webm'), 'still recording');

  // Not runs.
  write(path.join(runs, 'notes.txt'), 'a file');
  write(path.join(runs, '.hidden', 'result.json'), result('.hidden', 0));
  mkdirSync(path.join(runs, 'empty-dir'));
  write(path.join(outside, 'result.json'), result('outside', NOW - 99 * DAY));
  linkDir(outside, path.join(runs, 'linked'));
  await age(path.join(runs, '.hidden'), NOW - 99 * DAY);
  await age(path.join(runs, 'empty-dir'), NOW - 99 * DAY);
}

function reportedFile(): string {
  return runnerPaths(host).reportedRuns;
}

function report(id: string, runId: string): void {
  appendReportedRun(reportedFile(), {
    id,
    runDir: path.join(runs, runId),
    at: new Date(NOW).toISOString(),
    projectId: 'p1',
    server: 'https://demoflow.example',
  });
}

function remaining(): string[] {
  return readdirSync(runs).sort();
}

describe('demoflow runs list', () => {
  it('lists settled, partial and active runs newest first, with size and page URL', async () => {
    await seed();
    report('srv 1', OLD);
    const io = capture();
    expect(await runsListCommand({}, io, deps())).toBe(0);
    const lines = io.out.trimEnd().split('\n');
    expect(lines[0]).toBe(`Runs in ${runs}`);
    const date = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}';
    expect(lines.slice(1, -1).map((line) => line.split('  ').at(-1))).toEqual([
      NEW,
      RUNNING,
      SCENARIO_ONLY,
      OLD,
      'https://demoflow.example/app/projects/p1/runs/srv%201',
      ACTIVE,
    ]);
    expect(lines[1]).toMatch(
      new RegExp(
        `^completed {2}${date} {2}\\d+ B {2}Scenario ${NEW} {2}${NEW}$`,
      ),
    );
    expect(lines[2]).toMatch(new RegExp(`^partial {2}${date} .* ${RUNNING}$`));
    expect(lines[3]).toMatch(
      new RegExp(`^partial {2}${date} {2}2 B {2}- {2}${SCENARIO_ONLY}$`),
    );
    expect(lines[4]).toMatch(
      new RegExp(
        `^completed {2}${date} {2}\\d\\.\\d KB {2}Scenario ${OLD} {2}${OLD}$`,
      ),
    );
    expect(lines[5]).toBe(
      '  https://demoflow.example/app/projects/p1/runs/srv%201',
    );
    expect(lines[6]).toMatch(new RegExp(`^active {2}${date} .* ${ACTIVE}$`));
    expect(lines.at(-1)).toMatch(/^5 runs, \d+\.\d KB$/);
    expect(io.out).not.toContain('linked');
    expect(io.out).not.toContain('.hidden');
    expect(io.out).not.toContain('empty-dir');
    expect(io.out).not.toContain('notes.txt');
  });

  it('--json prints the documented shape and nothing else', async () => {
    await seed();
    report('srv 1', OLD);
    const io = capture();
    expect(await runsListCommand({ json: true }, io, deps())).toBe(0);
    expect(io.out.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(io.out) as {
      home: string;
      runs: Record<string, unknown>[];
    };
    expect(parsed.home).toBe(runs);
    expect(parsed.runs.map((run) => [run.id, run.state])).toEqual([
      [NEW, 'settled'],
      [RUNNING, 'partial'],
      [SCENARIO_ONLY, 'partial'],
      [OLD, 'settled'],
      [ACTIVE, 'active'],
    ]);
    const old = parsed.runs[3];
    expect(old).toEqual({
      id: OLD,
      state: 'settled',
      status: 'completed',
      scenarioName: `Scenario ${OLD}`,
      scenarioId: 'demoflow/login.demo.json',
      startedAt: new Date(NOW - 60 * DAY).toISOString(),
      modifiedAt: new Date(NOW - 60 * DAY).toISOString(),
      sizeBytes: expect.any(Number),
      pageUrl: 'https://demoflow.example/app/projects/p1/runs/srv%201',
    });
    expect(Object.keys(parsed.runs[2] ?? {}).sort()).toEqual([
      'id',
      'modifiedAt',
      'sizeBytes',
      'state',
    ]);
    expect(parsed.runs[1]?.status).toBe('running');
  });

  it('a missing or empty runs/ prints the empty line, exit 0', async () => {
    const io = capture();
    expect(await runsListCommand({}, io, deps())).toBe(0);
    expect(io.out).toBe(`No runs in ${runs}.\n`);
    mkdirSync(runs, { recursive: true });
    const again = capture();
    expect(await runsListCommand({}, again, deps())).toBe(0);
    expect(again.out).toBe(`No runs in ${runs}.\n`);
  });

  it('works outside a project, in the OS data dir and with a relative --out', async () => {
    const bare: HostEnvironment = { ...host, env: {} };
    const dataRuns = path.join(osDataDir(bare), 'runs');
    write(path.join(dataRuns, OLD, 'scenario.json'), '{}');
    const io = capture();
    expect(await runsListCommand({}, io, deps({ host: bare }))).toBe(0);
    expect(io.out.split('\n')[0]).toBe(`Runs in ${dataRuns}`);
    expect(io.out).toContain(OLD);

    write(path.join(dir, 'elsewhere', 'runs', NEW, 'scenario.json'), '{}');
    const out = capture();
    expect(
      await runsListCommand({ out: 'elsewhere' }, out, deps({ host: bare })),
    ).toBe(0);
    expect(out.out.split('\n')[0]).toBe(
      `Runs in ${path.join(dir, 'elsewhere', 'runs')}`,
    );
    expect(out.out).toContain(NEW);
  });

  it('an invalid project config is still exit 2', async () => {
    write(path.join(dir, 'demoflow.config.json'), '{ not json');
    await expect(runsListCommand({}, capture(), deps())).rejects.toMatchObject({
      code: 'invalid-config',
      exitCode: 2,
    });
  });
});

describe('demoflow runs delete', () => {
  it('removes a settled and a partial run, exit 0', async () => {
    await seed();
    const io = capture();
    const code = await runsDeleteCommand(
      [OLD, SCENARIO_ONLY, RUNNING],
      {},
      io,
      deps(),
    );
    expect(code).toBe(0);
    expect(io.out.trimEnd().split('\n')).toEqual([
      `Runs in ${runs}`,
      expect.stringMatching(new RegExp(`^deleted ${OLD} \\(\\d\\.\\d KB\\)$`)),
      `deleted ${SCENARIO_ONLY} (2 B)`,
      expect.stringMatching(new RegExp(`^deleted ${RUNNING} \\(`)),
    ]);
    expect(remaining()).toEqual(
      [ACTIVE, NEW, '.hidden', 'empty-dir', 'linked', 'notes.txt'].sort(),
    );
  });

  it('an unknown id and an active run exit 1, and the other ids are still deleted', async () => {
    await seed();
    const io = capture();
    const code = await runsDeleteCommand(
      ['nope', ACTIVE, NEW, 'linked', 'empty-dir'],
      {},
      io,
      deps(),
    );
    expect(code).toBe(1);
    expect(io.out.trimEnd().split('\n')).toEqual([
      `Runs in ${runs}`,
      'not found nope',
      `refused ${ACTIVE}: modified 0s ago, it may still be running`,
      expect.stringMatching(new RegExp(`^deleted ${NEW} `)),
      'not found linked',
      'not found empty-dir',
    ]);
    expect(existsSync(path.join(runs, ACTIVE))).toBe(true);
    expect(existsSync(path.join(runs, NEW))).toBe(false);
    expect(existsSync(path.join(outside, 'result.json'))).toBe(true);
    expect(lstatSync(path.join(runs, 'linked')).isSymbolicLink()).toBe(true);
  });

  it.each([
    '../x',
    'a/b',
    '.hidden',
  ])('%s exits 2 before anything is removed', async (bad) => {
    await seed();
    const before = remaining();
    const io = capture();
    const code = await main(['runs', 'delete', OLD, bad, '--out', home], io);
    expect(code).toBe(2);
    expect(io.err).toMatch(/^invalid-run-id: /);
    expect(remaining()).toEqual(before);
  });

  it('--dry-run removes nothing and still exits 1 on a refusal', async () => {
    await seed();
    const before = remaining();
    const io = capture();
    expect(await runsDeleteCommand([OLD], { dryRun: true }, io, deps())).toBe(
      0,
    );
    expect(io.out).toMatch(new RegExp(`would delete ${OLD} \\(`));
    const refused = capture();
    expect(
      await runsDeleteCommand([OLD, ACTIVE], { dryRun: true }, refused, deps()),
    ).toBe(1);
    expect(refused.out).toContain(`refused ${ACTIVE}: `);
    expect(remaining()).toEqual(before);
  });

  it('a link inside a deleted run is removed as a link; its target survives', async () => {
    await seed();
    linkDir(outside, path.join(runs, OLD, 'escape'));
    await age(path.join(runs, OLD), NOW - 60 * DAY);
    expect(await runsDeleteCommand([OLD], {}, capture(), deps())).toBe(0);
    expect(existsSync(path.join(runs, OLD))).toBe(false);
    expect(readdirSync(outside)).toEqual(['result.json']);
  });

  it('an EBUSY from rm prints failed and the next id is still processed', async () => {
    await seed();
    const busy: RunsFs = {
      ...nodeRunsFs,
      rm: async (target, options) => {
        if (path.basename(target) === OLD) {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), {
            code: 'EBUSY',
          });
        }
        await nodeRunsFs.rm(target, options);
      },
    };
    const io = capture();
    const code = await runsDeleteCommand(
      [OLD, NEW],
      {},
      io,
      deps({ fs: busy }),
    );
    expect(code).toBe(1);
    expect(io.out).toContain(`failed ${OLD}: EBUSY: resource busy or locked\n`);
    expect(io.out).toMatch(new RegExp(`deleted ${NEW} `));
    expect(existsSync(path.join(runs, OLD))).toBe(true);
    expect(existsSync(path.join(runs, NEW))).toBe(false);
  });

  it('refuses a run swapped for a link between scan and removal', async () => {
    await seed();
    const swapping: RunsFs = {
      ...nodeRunsFs,
      realpath: async (file) => {
        rmSync(path.join(runs, OLD), { recursive: true });
        linkDir(outside, path.join(runs, OLD));
        return nodeRunsFs.realpath(file);
      },
    };
    const io = capture();
    expect(await runsDeleteCommand([OLD], {}, io, deps({ fs: swapping }))).toBe(
      1,
    );
    expect(io.out).toMatch(
      new RegExp(`failed ${OLD}: .*no longer a directory`),
    );
    expect(readdirSync(outside)).toEqual(['result.json']);
  });
});

describe('demoflow runs prune', () => {
  it('--older-than 30d removes only older runs, oldest first, skips active', async () => {
    await seed();
    const io = capture();
    expect(await runsPruneCommand({ olderThan: '30d' }, io, deps())).toBe(0);
    const lines = io.out.trimEnd().split('\n');
    expect(lines[0]).toBe(`Runs in ${runs}`);
    expect(lines[1]).toMatch(new RegExp(`^deleted ${OLD} `));
    expect(lines[2]).toBe(`deleted ${SCENARIO_ONLY} (2 B)`);
    expect(lines[3]).toBe('skipped 1 active');
    expect(lines[4]).toMatch(/^Freed \d+\.\d KB$/);
    expect(remaining()).toEqual(
      [
        ACTIVE,
        NEW,
        RUNNING,
        '.hidden',
        'empty-dir',
        'linked',
        'notes.txt',
      ].sort(),
    );
  });

  it('--partial-only removes only partial runs', async () => {
    await seed();
    expect(
      await runsPruneCommand({ partialOnly: true }, capture(), deps()),
    ).toBe(0);
    expect(existsSync(path.join(runs, SCENARIO_ONLY))).toBe(false);
    expect(existsSync(path.join(runs, RUNNING))).toBe(false);
    expect(existsSync(path.join(runs, OLD))).toBe(true);
    expect(existsSync(path.join(runs, NEW))).toBe(true);
    expect(existsSync(path.join(runs, ACTIVE))).toBe(true);
  });

  it('both filters remove the intersection', async () => {
    await seed();
    const io = capture();
    expect(
      await runsPruneCommand(
        { olderThan: '30d', partialOnly: true },
        io,
        deps(),
      ),
    ).toBe(0);
    expect(io.out).toContain(`deleted ${SCENARIO_ONLY} (2 B)\n`);
    expect(existsSync(path.join(runs, SCENARIO_ONLY))).toBe(false);
    expect(existsSync(path.join(runs, RUNNING))).toBe(true);
    expect(existsSync(path.join(runs, OLD))).toBe(true);
  });

  it('--dry-run removes nothing and prints Would free', async () => {
    await seed();
    const before = remaining();
    const io = capture();
    expect(
      await runsPruneCommand({ olderThan: '1h', dryRun: true }, io, deps()),
    ).toBe(0);
    expect(io.out).toMatch(new RegExp(`would delete ${OLD} \\(`));
    expect(io.out).toMatch(/\nWould free \d+\.\d KB\n$/);
    expect(remaining()).toEqual(before);
  });

  it('nothing matching is exit 0 and frees nothing', async () => {
    await seed();
    const io = capture();
    expect(await runsPruneCommand({ olderThan: '52w' }, io, deps())).toBe(0);
    expect(io.out.trimEnd().split('\n').slice(1)).toEqual([
      'skipped 1 active',
      'Freed 0 B',
    ]);
  });

  it.each([
    [['--older-than', '30x'], 'invalid-duration'],
    [['--older-than', '0d'], 'invalid-duration'],
    [['--older-than', '30D'], 'invalid-duration'],
    [[], 'prune-needs-a-filter'],
  ])('%j exits 2 with %s and removes nothing', async (args, code) => {
    await seed();
    const before = remaining();
    const io = capture();
    expect(await main(['runs', 'prune', '--out', home, ...args], io)).toBe(2);
    expect(io.err).toMatch(new RegExp(`^${code}: `));
    expect(io.out).toBe('');
    expect(remaining()).toEqual(before);
  });

  it('an EBUSY from rm prints failed, exit 1, and the next run is still pruned', async () => {
    await seed();
    const busy: RunsFs = {
      ...nodeRunsFs,
      rm: async (target, options) => {
        if (path.basename(target) === OLD) {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), {
            code: 'EBUSY',
          });
        }
        await nodeRunsFs.rm(target, options);
      },
    };
    const io = capture();
    expect(
      await runsPruneCommand({ olderThan: '30d' }, io, deps({ fs: busy })),
    ).toBe(1);
    expect(io.out).toContain(`failed ${OLD}: EBUSY`);
    expect(io.out).toContain(`deleted ${SCENARIO_ONLY} (2 B)`);
    expect(io.out).toContain('Freed 2 B');
  });
});

describe('reported-runs.jsonl', () => {
  it('is byte-for-byte unchanged after delete and prune; video.open answers not-found', async () => {
    await seed();
    report('srv-old', OLD);
    report('srv-scenario', SCENARIO_ONLY);
    const file = reportedFile();
    const before = readFileSync(file);
    const relay = {
      indexFile: file,
      fs: nodeRelayFs,
      logger: memoryLogger(),
      platform: process.platform,
    };
    expect(await locateVideo('srv-old', 'mp4', relay)).not.toBeNull();

    expect(await runsDeleteCommand([OLD], {}, capture(), deps())).toBe(0);
    expect(
      await runsPruneCommand({ partialOnly: true }, capture(), deps()),
    ).toBe(0);

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(await findReportedRun(file, 'srv-old')).toMatchObject({
      runDir: path.join(runs, OLD),
    });
    expect(await locateVideo('srv-old', 'mp4', relay)).toBeNull();
  });
});

describe('demoflow runs --help', () => {
  it.each([
    [
      ['runs', '--help'],
      ['list', 'delete', 'prune', '--dry-run'],
    ],
    [
      ['runs', 'list', '--help'],
      ['--json', '--out <dir>'],
    ],
    [
      ['runs', 'delete', '--help'],
      ['<id...>', '--dry-run', '--out <dir>'],
    ],
    [
      ['runs', 'prune', '--help'],
      ['--older-than <duration>', '--partial-only', '--dry-run', '--out <dir>'],
    ],
  ])('%j lists its flags', async (argv, expected) => {
    const io = capture();
    expect(await main(argv, io)).toBe(0);
    for (const text of expected) expect(io.out).toContain(text);
    expect(io.out).not.toContain('--project');
  });
});

describe('parseDuration and formatSize', () => {
  it('parses one positive integer and one unit', () => {
    expect(parseDuration('90m')).toBe(90 * 60 * 1000);
    expect(parseDuration('12h')).toBe(12 * 60 * 60 * 1000);
    expect(parseDuration('30d')).toBe(30 * DAY);
    expect(parseDuration('2w')).toBe(14 * DAY);
    for (const bad of [
      '',
      'd',
      '1',
      '1.5d',
      '-1d',
      '01d',
      '1d2h',
      ' 1d',
      '1y',
    ]) {
      expect(() => parseDuration(bad)).toThrow(/--older-than/);
    }
  });

  it('prints B, KB, MB and GB in steps of 1024', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

/** An in-memory filesystem with Windows paths. */
function windowsFs(entries: Record<string, string | null>, mtimeMs: number) {
  const p = path.win32;
  const removed: string[] = [];
  const stat = (file: string): RunsStat => {
    if (!(file in entries)) {
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    }
    const content = entries[file];
    return {
      isDirectory: () => content === null,
      isSymbolicLink: () => false,
      size: content === null ? 0 : content.length,
      mtimeMs,
    };
  };
  const fs: RunsFs = {
    lstat: async (file) => stat(file),
    readdir: async (dirPath) => {
      stat(dirPath);
      return Object.keys(entries)
        .filter((file) => p.dirname(file) === dirPath && file !== dirPath)
        .map((file) => p.basename(file));
    },
    readFile: async (file) => {
      const content = entries[file];
      if (typeof content !== 'string') throw new Error(`EISDIR: ${file}`);
      return content;
    },
    realpath: async (file) => file,
    rm: async (target) => {
      removed.push(target);
      for (const file of Object.keys(entries)) {
        if (file === target || file.startsWith(`${target}\\`)) {
          delete entries[file];
        }
      }
    },
  };
  return { fs, removed };
}

describe('Windows paths', () => {
  it('matches ids case-insensitively and removes only the run under <home>\\runs', async () => {
    const winHome = 'C:\\Users\\me\\demoflow';
    const winRuns = `${winHome}\\runs`;
    const { fs, removed } = windowsFs(
      {
        [winHome]: null,
        [winRuns]: null,
        [`${winRuns}\\run-a`]: null,
        [`${winRuns}\\run-a\\scenario.json`]: '{}',
        [`${winRuns}\\run-b`]: null,
        [`${winRuns}\\run-b\\scenario.json`]: '{}',
      },
      NOW - 40 * DAY,
    );
    const winHost: HostEnvironment = {
      platform: 'win32',
      env: { DEMOFLOW_HOME: winHome },
      homedir: 'C:\\Users\\me',
    };
    const winDeps = deps({
      host: winHost,
      cwd: 'C:\\work',
      fs,
    });
    const io = capture();
    const code = await runsDeleteCommand(
      ['RUN-A'],
      { project: 'C:\\work' },
      io,
      winDeps,
    );
    expect(code).toBe(0);
    expect(io.out).toBe(`Runs in ${winRuns}\ndeleted run-a (2 B)\n`);
    expect(removed).toEqual([`${winRuns}\\run-a`]);

    const listed = capture();
    await runsListCommand({ project: 'C:\\work', json: true }, listed, winDeps);
    const parsed = JSON.parse(listed.out) as {
      home: string;
      runs: { id: string }[];
    };
    expect(parsed.home).toBe(winRuns);
    expect(parsed.runs.map((run) => run.id)).toEqual(['run-b']);
  });
});
