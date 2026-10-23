import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactsDeleter,
  type ArtifactsFs,
  candidateRunDir,
  nodeArtifactsFs,
} from '../../src/runner/artifacts/index.ts';
import {
  nodeRelayFs,
  type RelayFs,
  VideoRelay,
} from '../../src/runner/relay/index.ts';
import {
  type RelayFile,
  type RelaySender,
  WINDOW_BYTES,
} from '../../src/runner/relay/stream.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { memoryLogger } from './fakes.ts';

const RUN_ID = 'srv-run-1';
const LOCAL_ID = 'local-run';

let home: string;
let runDir: string;
let indexFile: string;
let logger: ReturnType<typeof memoryLogger>;
let order: string[];

function result(runId = LOCAL_ID): RunResult {
  const done = { status: 'passed' } as const;
  return {
    schemaVersion: 1,
    runId,
    scenarioId: 'demoflow/a.demo.json',
    scenarioName: 'A',
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: '2026-10-22T10:00:01.000Z',
    status: 'completed',
    stages: {
      readiness: done,
      execution: done,
      verification: done,
      recording: done,
      rendering: done,
      storage: { status: 'skipped' },
    },
    renders: [
      {
        renderer: 'ffmpeg',
        format: 'mp4',
        file: 'render/ffmpeg.mp4',
        durationMs: 1,
        sizeBytes: 1,
        width: 1280,
        height: 720,
        fps: 30,
      },
    ],
    warnings: [],
  };
}

/** A run directory as the CLI leaves it: `result.json` and a render. */
function makeRun(dir: string, runId = path.basename(dir)): void {
  mkdirSync(path.join(dir, 'render'), { recursive: true });
  writeFileSync(path.join(dir, 'render', 'ffmpeg.mp4'), 'video');
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result(runId)));
}

function report(dir: string, id = RUN_ID): void {
  appendReportedRun(indexFile, { id, runDir: dir, at: 'x' });
}

function recordingSender() {
  const sender = {
    messages: [] as Array<Record<string, unknown>>,
    send(message: Record<string, unknown>) {
      sender.messages.push(message);
    },
    sendBinary() {},
  };
  return sender satisfies RelaySender;
}

/** The real filesystem, recording each `rm`. */
function recordingFs(rm: ArtifactsFs['rm'] = nodeArtifactsFs.rm): ArtifactsFs {
  return {
    ...nodeArtifactsFs,
    rm: (dir) => {
      order.push('rm');
      return rm(dir);
    },
  };
}

function deleter(
  fs: ArtifactsFs = recordingFs(),
  closeRun: (runId: string) => Promise<void> = async (runId) => {
    order.push(`closeRun ${runId}`);
  },
): ArtifactsDeleter {
  return new ArtifactsDeleter({
    indexFile,
    fs,
    logger,
    platform: process.platform,
    homeDir: home,
    closeRun,
  });
}

/** Sends one `artifacts.delete` and waits for its answer. */
async function request(
  target: ArtifactsDeleter,
  runId = RUN_ID,
): Promise<Record<string, unknown>> {
  const sender = recordingSender();
  const requestId = randomUUID();
  target.handle({ type: 'artifacts.delete', requestId, runId }, sender);
  await until(() => sender.messages.length > 0, 'an answer');
  const [answer] = sender.messages;
  expect(answer?.requestId).toBe(requestId);
  const { requestId: _, ...rest } = answer ?? {};
  return rest;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const NOT_FOUND = { type: 'artifacts.error', code: 'not-found' };
const DELETED = { type: 'artifacts.deleted' };

/** Decision 8: one line per request, and never a path. */
function expectLogged(outcome: string): void {
  expect(logger.lines.at(-1)).toEqual({
    level: 'info',
    message: `artifacts ${RUN_ID}: ${outcome}`,
  });
  expect(logger.text()).not.toContain(home);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-artifacts-')));
  runDir = path.join(home, 'runs', LOCAL_ID);
  makeRun(runDir);
  indexFile = path.join(home, 'reported-runs.jsonl');
  logger = memoryLogger();
  order = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('candidateRunDir', () => {
  it.each([
    [
      '/home/u/.demoflow/runs/r1',
      '/home/u',
      'linux',
      '/home/u/.demoflow/runs/r1',
    ],
    [
      '/home/u/.demoflow/runs/x/../r1',
      '/home/u',
      'linux',
      '/home/u/.demoflow/runs/r1',
    ],
    ['runs/r1', '/home/u', 'linux', null],
    ['/', '/home/u', 'linux', null],
    ['/runs', '/home/u', 'linux', null],
    ['/home/u/runs', '/home/u', 'linux', null],
    ['/home/u/runs/runs', '/home/u', 'linux', null],
    ['/runs/u', '/runs/u', 'linux', null],
    ['/home/u/.demoflow/out/r1', '/home/u', 'linux', null],
    ['/home/u/.demoflow/Runs/r1', '/home/u', 'linux', null],
    ['C:\\', 'C:\\Users\\u', 'win32', null],
    [
      'C:\\Users\\u\\.demoflow\\Runs\\r1',
      'C:\\Users\\u',
      'win32',
      'C:\\Users\\u\\.demoflow\\Runs\\r1',
    ],
    ['C:\\Runs\\U', 'c:\\runs\\u', 'win32', null],
  ] as const)('%s with home %s on %s → %s', (dir, homeDir, platform, expected) => {
    expect(candidateRunDir(dir, homeDir, platform)).toBe(expected);
  });
});

describe('ArtifactsDeleter: what it deletes', () => {
  it('removes a reported run directory and answers artifacts.deleted', async () => {
    report(runDir);
    expect(await request(deleter())).toEqual(DELETED);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(path.join(home, 'runs'))).toBe(true);
    // Decision 4: the run's streams are closed before anything is removed.
    expect(order).toEqual([`closeRun ${RUN_ID}`, 'rm']);
    expectLogged('deleted');
  });

  it('answers artifacts.deleted when the directory is already gone', async () => {
    report(runDir);
    rmSync(runDir, { recursive: true });
    expect(await request(deleter())).toEqual(DELETED);
    expect(order).toEqual([]);
    expectLogged('already-gone');
  });

  it('answers artifacts.deleted again for a run it deleted before', async () => {
    report(runDir);
    const target = deleter();
    expect(await request(target)).toEqual(DELETED);
    expect(await request(target)).toEqual(DELETED);
    expectLogged('already-gone');
  });

  it('answers not-found for a run this machine never reported', async () => {
    report(runDir);
    expect(await request(deleter(), 'srv-run-9')).toEqual(NOT_FOUND);
    expect(existsSync(runDir)).toBe(true);
    expect(logger.lines.at(-1)?.message).toBe('artifacts srv-run-9: not-found');
  });

  it('removes a symlink inside the run as a link, and keeps its target', async (ctx) => {
    const secret = path.join(home, 'secret.txt');
    writeFileSync(secret, 'secret');
    try {
      symlinkSync(secret, path.join(runDir, 'render', 'link.txt'), 'file');
    } catch (error) {
      // Windows refuses file symlinks without Developer Mode or admin rights.
      if (process.platform === 'win32') {
        ctx.skip(`file symlinks need a privilege here: ${String(error)}`);
      }
      throw error;
    }
    report(runDir);
    expect(await request(deleter())).toEqual(DELETED);
    expect(existsSync(runDir)).toBe(false);
    expect(readFileSync(secret, 'utf8')).toBe('secret');
  });

  it('removes a junction inside the run as a link, and keeps the directory it names', async () => {
    // A junction needs no privilege, so this runs on Windows too.
    const outside = path.join(home, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, path.join(runDir, 'linked'), 'junction');
    report(runDir);
    expect(await request(deleter())).toEqual(DELETED);
    expect(existsSync(runDir)).toBe(false);
    expect(readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('ArtifactsDeleter: the boundary (Decision 3)', () => {
  /** Answers not-found, logs `refused`, removes nothing, and leaves `kept` in place. */
  async function expectRefused(kept: string[]): Promise<void> {
    expect(await request(deleter())).toEqual(NOT_FOUND);
    expect(order).toEqual([]);
    for (const file of kept) expect(existsSync(file)).toBe(true);
    expectLogged('refused');
  }

  it('refuses a directory whose parent is not named runs', async () => {
    const dir = path.join(home, 'elsewhere', LOCAL_ID);
    makeRun(dir);
    report(dir);
    await expectRefused([path.join(dir, 'result.json')]);
  });

  it('refuses a directory whose name differs from result.json’s runId', async () => {
    const dir = path.join(home, 'runs', 'another-run');
    makeRun(dir, LOCAL_ID);
    report(dir);
    await expectRefused([path.join(dir, 'result.json')]);
  });

  it('refuses a directory without result.json', async () => {
    rmSync(path.join(runDir, 'result.json'));
    report(runDir);
    await expectRefused([path.join(runDir, 'render', 'ffmpeg.mp4')]);
  });

  it.each([
    ['not JSON', '{'],
    ['not a run result', JSON.stringify({ runId: LOCAL_ID })],
  ])('refuses a result.json that is %s', async (_, text) => {
    writeFileSync(path.join(runDir, 'result.json'), text);
    report(runDir);
    await expectRefused([
      path.join(runDir, 'result.json'),
      path.join(runDir, 'render', 'ffmpeg.mp4'),
    ]);
  });

  it('refuses a run directory that is a link to a real run directory', async () => {
    const real = path.join(home, 'real', 'runs', LOCAL_ID);
    makeRun(real);
    rmSync(runDir, { recursive: true });
    // A junction is a link to lstat on Windows and needs no privilege there.
    symlinkSync(real, runDir, 'junction');
    report(runDir);
    await expectRefused([runDir, path.join(real, 'result.json')]);
  });

  it('refuses a run directory that is a file', async () => {
    const file = path.join(home, 'runs', 'file-run');
    writeFileSync(file, JSON.stringify(result('file-run')));
    report(file);
    await expectRefused([file]);
  });

  it('refuses the runs directory itself and the home directory', async () => {
    report(path.join(home, 'runs'));
    await expectRefused([runDir]);
    report(home);
    await expectRefused([runDir]);
  });
});

describe('ArtifactsDeleter: failures and concurrency', () => {
  it('answers io when the removal fails, and a retry finishes the job', async () => {
    report(runDir);
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const target = deleter(
      recordingFs(async () => {
        throw busy;
      }),
    );
    expect(await request(target)).toEqual({
      type: 'artifacts.error',
      code: 'io',
    });
    expectLogged('io');
    expect(await request(deleter())).toEqual(DELETED);
    expect(existsSync(runDir)).toBe(false);
  });

  it('answers deleted when the directory vanishes during the removal', async () => {
    report(runDir);
    const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const target = deleter(
      recordingFs(async () => {
        throw gone;
      }),
    );
    expect(await request(target)).toEqual(DELETED);
  });

  it('runs rm once for two concurrent requests, and answers both', async () => {
    report(runDir);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = deleter(
      recordingFs(async (dir) => {
        await gate;
        await nodeArtifactsFs.rm(dir);
      }),
    );
    const sender = recordingSender();
    const ids = [randomUUID(), randomUUID()];
    for (const requestId of ids) {
      target.handle(
        { type: 'artifacts.delete', requestId, runId: RUN_ID },
        sender,
      );
    }
    await until(() => order.includes('rm'), 'the removal');
    release();
    await until(() => sender.messages.length === 2, 'both answers');
    expect(order.filter((step) => step === 'rm')).toHaveLength(1);
    expect(sender.messages).toEqual(
      ids.map((requestId) => ({ type: 'artifacts.deleted', requestId })),
    );
    expect(existsSync(runDir)).toBe(false);
  });

  it.each([
    [{ type: 'artifacts.delete', runId: RUN_ID }],
    [{ type: 'artifacts.delete', requestId: 'q' }],
    [{ type: 'artifacts.delete', requestId: 7, runId: RUN_ID }],
    [{ type: 'artifacts.delete', requestId: 'q', runId: '../runs' }],
  ])('ignores a malformed request %j', async (message) => {
    report(runDir);
    const sender = recordingSender();
    deleter().handle(message, sender);
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sender.messages).toEqual([]);
    expect(existsSync(runDir)).toBe(true);
    expect(logger.lines).toEqual([
      { level: 'warn', message: 'ignored a malformed artifacts.delete' },
    ]);
  });
});

describe('ArtifactsDeleter and the video relay', () => {
  it('closes the run’s open stream with io and releases its file before removing', async () => {
    // Larger than the window: the stream waits for acks and stays open.
    writeFileSync(
      path.join(runDir, 'render', 'ffmpeg.mp4'),
      Buffer.alloc(2 * WINDOW_BYTES),
    );
    report(runDir);
    const counts = { open: 0, close: 0 };
    const fs: RelayFs = {
      ...nodeRelayFs,
      open: async (file) => {
        const handle = await nodeRelayFs.open(file);
        counts.open++;
        const counted: RelayFile = {
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, length, position),
          close: async () => {
            counts.close++;
            await handle.close();
          },
        };
        return counted;
      },
    };
    const relay = new VideoRelay({
      indexFile,
      fs,
      logger,
      platform: process.platform,
    });
    const sender = recordingSender();
    const streamId = randomUUID();
    relay.handle(
      {
        type: 'video.open',
        streamId,
        runId: RUN_ID,
        format: 'mp4',
        range: null,
      },
      sender,
    );
    await until(() => sender.messages.length > 0, 'video.head');
    const target = deleter(
      recordingFs(async (dir) => {
        order.push(`handles ${counts.open - counts.close}`);
        await nodeArtifactsFs.rm(dir);
      }),
      (runId) => relay.closeRun(runId),
    );
    target.handle(
      { type: 'artifacts.delete', requestId: 'q', runId: RUN_ID },
      sender,
    );
    await until(
      () => sender.messages.some((m) => m.type === 'artifacts.deleted'),
      'artifacts.deleted',
    );
    expect(sender.messages.map((m) => m.type)).toEqual([
      'video.head',
      'video.error',
      'artifacts.deleted',
    ]);
    expect(sender.messages[1]).toEqual({
      type: 'video.error',
      streamId,
      code: 'io',
    });
    expect(order).toEqual(['rm', 'handles 0']);
    expect(relay.size).toBe(0);
    expect(existsSync(runDir)).toBe(false);
  });
});
