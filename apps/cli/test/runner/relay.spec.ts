import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RenderFormat, RunResult } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isInside,
  MAX_STREAMS,
  nodeRelayFs,
  type RelayFs,
  VideoRelay,
} from '../../src/runner/relay/index.ts';
import type { VideoRange } from '../../src/runner/relay/range.ts';
import {
  CHUNK_BYTES,
  FRAME_HEADER_BYTES,
  FRAME_VERSION,
  type RelayFile,
  type RelaySender,
  streamIdBytes,
  WINDOW_BYTES,
} from '../../src/runner/relay/stream.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { memoryLogger } from './fakes.ts';

const RUN_ID = 'srv-run-1';

let home: string;
let runDir: string;
let indexFile: string;
let video: Buffer;
let logger: ReturnType<typeof memoryLogger>;
let counts: { open: number; close: number };
let relay: VideoRelay;

/** The real filesystem, counting every handle opened and closed. */
function countingFs(base: RelayFs = nodeRelayFs): RelayFs {
  return {
    realpath: (file) => base.realpath(file),
    readFile: (file) => base.readFile(file),
    open: async (file) => {
      const handle = await base.open(file);
      counts.open++;
      let closed = false;
      const counted: RelayFile = {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) =>
          handle.read(buffer, offset, length, position),
        close: async () => {
          if (!closed) counts.close++;
          closed = true;
          await handle.close();
        },
      };
      return counted;
    },
  };
}

/** A socket that records frames and acknowledges only when told to. */
function recordingSender() {
  const sender = {
    messages: [] as Array<Record<string, unknown>>,
    chunks: [] as Uint8Array[],
    send(message: Record<string, unknown>) {
      sender.messages.push(message);
    },
    sendBinary(data: Uint8Array) {
      sender.chunks.push(data);
    },
    of(streamId: string) {
      const bytes = streamIdBytes(streamId);
      return sender.chunks.filter((chunk) =>
        bytes.every((byte, i) => chunk[i + 1] === byte),
      );
    },
    messagesOf(streamId: string) {
      return sender.messages.filter((m) => m.streamId === streamId);
    },
  };
  return sender satisfies RelaySender;
}

type Sender = ReturnType<typeof recordingSender>;

function writeResult(
  renders: Array<{ format: RenderFormat; file: string }>,
  dir = runDir,
): void {
  const done = { status: 'passed' } as const;
  const result: RunResult = {
    schemaVersion: 1,
    runId: 'local-run',
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
    renders: renders.map((render) => ({
      renderer: 'ffmpeg',
      durationMs: 1,
      sizeBytes: 1,
      width: 1280,
      height: 720,
      fps: 30,
      ...render,
    })),
    warnings: [],
  };
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
}

function open(
  sender: Sender,
  options: {
    runId?: string;
    format?: RenderFormat;
    range?: VideoRange | null;
    streamId?: string;
  } = {},
): string {
  const streamId = options.streamId ?? randomUUID();
  relay.handle(
    {
      type: 'video.open',
      streamId,
      runId: options.runId ?? RUN_ID,
      format: options.format ?? 'mp4',
      range: options.range ?? null,
    },
    sender,
  );
  return streamId;
}

/** Real file I/O: wait on the event loop until `done` holds. */
async function until(done: () => boolean, what = 'condition'): Promise<void> {
  // By the clock, not by ticks: a loaded CI runner needs more ticks per read.
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Acknowledges every chunk until the stream ends; returns its data. */
async function drain(sender: Sender, streamId: string): Promise<Buffer> {
  let acked = 0;
  const ended = () =>
    sender
      .messagesOf(streamId)
      .some((m) => m.type === 'video.end' || m.type === 'video.error');
  const deadline = performance.now() + 10_000;
  while (!ended() && performance.now() < deadline) {
    const chunks = sender.of(streamId);
    for (; acked < chunks.length; acked++) {
      relay.handle(
        {
          type: 'video.ack',
          streamId,
          bytes: (chunks[acked]?.length ?? 0) - FRAME_HEADER_BYTES,
        },
        sender,
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return Buffer.concat(
    sender.of(streamId).map((chunk) => chunk.subarray(FRAME_HEADER_BYTES)),
  );
}

function errorOf(sender: Sender, streamId: string) {
  return sender.messagesOf(streamId).find((m) => m.type === 'video.error');
}

async function expectNotFound(sender: Sender, streamId: string) {
  await until(() => errorOf(sender, streamId) !== undefined, 'video.error');
  expect(errorOf(sender, streamId)).toEqual({
    type: 'video.error',
    streamId,
    code: 'not-found',
  });
  expect(sender.chunks).toEqual([]);
  expect(counts.close).toBe(counts.open);
  expect(relay.size).toBe(0);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-relay-')));
  runDir = path.join(home, 'runs', 'local-run');
  mkdirSync(path.join(runDir, 'render'), { recursive: true });
  indexFile = path.join(home, 'reported-runs.jsonl');
  // 100 KiB and a bit: three full chunks and a short one.
  video = randomBytes(3 * CHUNK_BYTES + 1234);
  writeFileSync(path.join(runDir, 'render', 'ffmpeg.mp4'), video);
  writeResult([{ format: 'mp4', file: 'render/ffmpeg.mp4' }]);
  appendReportedRun(indexFile, {
    id: RUN_ID,
    runDir,
    at: '2026-10-22T10:00:02.000Z',
  });
  logger = memoryLogger();
  counts = { open: 0, close: 0 };
  relay = new VideoRelay({
    indexFile,
    fs: countingFs(),
    logger,
    platform: process.platform,
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('isInside', () => {
  it.each([
    ['/runs/r1', '/runs/r1/render/a.mp4', 'linux', true],
    ['/runs/r1', '/runs/r1', 'linux', false],
    ['/runs/r1', '/runs/r10/a.mp4', 'linux', false],
    ['/runs/r1', '/runs/a.mp4', 'linux', false],
    ['/runs/r1', '/Runs/r1/a.mp4', 'linux', false],
    ['/runs/r1', '/runs/r1/..data', 'darwin', true],
    ['C:\\Runs\\R1', 'c:\\runs\\r1\\render\\a.mp4', 'win32', true],
    ['C:\\Runs\\R1', 'C:\\Runs\\R10\\a.mp4', 'win32', false],
    ['C:\\Runs\\R1', 'D:\\Runs\\R1\\a.mp4', 'win32', false],
    ['C:\\Runs\\R1', 'C:\\Windows\\win.ini', 'win32', false],
  ] as const)('%s ∋ %s on %s: %s', (root, target, platform, inside) => {
    expect(isInside(root, target, platform)).toBe(inside);
  });
});

describe('VideoRelay: what is served', () => {
  it('streams the whole file: head, chunks of at most 32 KiB, then end', async () => {
    const sender = recordingSender();
    const streamId = open(sender);
    const data = await drain(sender, streamId);
    expect(data.equals(video)).toBe(true);
    const messages = sender.messagesOf(streamId);
    expect(messages[0]).toEqual({
      type: 'video.head',
      streamId,
      size: video.length,
      start: 0,
      end: video.length - 1,
    });
    expect(messages.at(-1)).toEqual({ type: 'video.end', streamId });
    const header = streamIdBytes(streamId);
    for (const chunk of sender.chunks) {
      expect(chunk[0]).toBe(FRAME_VERSION);
      expect([...chunk.subarray(1, FRAME_HEADER_BYTES)]).toEqual([...header]);
      expect(chunk.length - FRAME_HEADER_BYTES).toBeLessThanOrEqual(
        CHUNK_BYTES,
      );
      expect(chunk.length).toBeGreaterThan(FRAME_HEADER_BYTES);
    }
    expect(sender.chunks).toHaveLength(4);
    expect(counts).toEqual({ open: 1, close: 1 });
    expect(relay.size).toBe(0);
  });

  it('writes one log line per stream, with the run id and no path', async () => {
    const sender = recordingSender();
    const streamId = open(sender);
    await drain(sender, streamId);
    await until(() => logger.lines.length > 0, 'log line');
    expect(logger.lines).toEqual([
      {
        level: 'info',
        message: `video ${RUN_ID} mp4: ${video.length} bytes sent, sent`,
      },
    ]);
    expect(logger.text()).not.toContain(home);
    expect(logger.text()).not.toContain('ffmpeg.mp4');
  });

  const LAST = 3 * CHUNK_BYTES + 1233;
  it.each([
    ['a-b', { start: 10, end: 40_000 }, 10, 40_000],
    ['a-', { start: 50_000 }, 50_000, LAST],
    ['-n', { suffix: 777 }, LAST + 1 - 777, LAST],
    ['an end past the size', { start: 5, end: 10_000_000 }, 5, LAST],
    ['one byte', { start: 7, end: 7 }, 7, 7],
  ] as const)('serves the range %s', async (_name, range, start, end) => {
    const sender = recordingSender();
    const streamId = open(sender, { range });
    const data = await drain(sender, streamId);
    expect(sender.messagesOf(streamId)[0]).toMatchObject({
      type: 'video.head',
      size: video.length,
      start,
      end,
    });
    expect(data.equals(video.subarray(start, end + 1))).toBe(true);
    expect(sender.messagesOf(streamId).at(-1)?.type).toBe('video.end');
    expect(counts).toEqual({ open: 1, close: 1 });
  });

  it.each([
    ['a start at the size', { start: 3 * CHUNK_BYTES + 1234 }],
    ['a zero suffix', { suffix: 0 }],
  ] as const)('answers %s with bad-range and the size', async (_name, range) => {
    const sender = recordingSender();
    const streamId = open(sender, { range });
    await until(() => errorOf(sender, streamId) !== undefined, 'video.error');
    expect(sender.messagesOf(streamId)).toEqual([
      { type: 'video.error', streamId, code: 'bad-range', size: video.length },
    ]);
    expect(sender.chunks).toEqual([]);
    expect(counts).toEqual({ open: 1, close: 1 });
  });

  it.each([
    ['whole', null],
    ['with a range', { start: 0 }],
  ] as const)('answers an empty file %s with bad-range', async (_name, range) => {
    writeFileSync(path.join(runDir, 'render', 'ffmpeg.mp4'), '');
    const sender = recordingSender();
    const streamId = open(sender, { range });
    await until(() => errorOf(sender, streamId) !== undefined, 'video.error');
    expect(sender.messagesOf(streamId)).toEqual([
      { type: 'video.error', streamId, code: 'bad-range', size: 0 },
    ]);
    expect(counts).toEqual({ open: 1, close: 1 });
  });

  it('serves the render of the asked format', async () => {
    const gif = randomBytes(999);
    writeFileSync(path.join(runDir, 'render', 'ffmpeg.gif'), gif);
    writeResult([
      { format: 'mp4', file: 'render/ffmpeg.mp4' },
      { format: 'gif', file: 'render/ffmpeg.gif' },
    ]);
    const sender = recordingSender();
    const streamId = open(sender, { format: 'gif' });
    expect((await drain(sender, streamId)).equals(gif)).toBe(true);
  });

  it('follows the last index entry for a run id', async () => {
    const other = path.join(home, 'runs', 'other');
    mkdirSync(path.join(other, 'render'), { recursive: true });
    const newer = randomBytes(500);
    writeFileSync(path.join(other, 'render', 'ffmpeg.mp4'), newer);
    writeResult([{ format: 'mp4', file: 'render/ffmpeg.mp4' }], other);
    appendReportedRun(indexFile, { id: RUN_ID, runDir: other, at: 'x' });
    const sender = recordingSender();
    const streamId = open(sender);
    expect((await drain(sender, streamId)).equals(newer)).toBe(true);
  });
});

describe('VideoRelay: the ADR-0008 boundary', () => {
  it('answers not-found for a run this machine never reported', async () => {
    const sender = recordingSender();
    await expectNotFound(sender, open(sender, { runId: 'someone-else' }));
  });

  it('answers not-found for a format missing from result.json', async () => {
    const sender = recordingSender();
    await expectNotFound(sender, open(sender, { format: 'webm' }));
  });

  it('answers not-found for a file with ..', async () => {
    writeFileSync(path.join(home, 'runs', 'secret.mp4'), 'secret');
    writeResult([{ format: 'mp4', file: '../secret.mp4' }]);
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('answers not-found for an absolute file outside the run', async () => {
    const secret = path.join(home, 'secret.mp4');
    writeFileSync(secret, 'secret');
    writeResult([{ format: 'mp4', file: secret }]);
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('answers not-found for a symlink that leaves the run directory', async (ctx) => {
    const secret = path.join(home, 'secret.mp4');
    writeFileSync(secret, 'secret');
    try {
      symlinkSync(secret, path.join(runDir, 'render', 'link.mp4'), 'file');
    } catch (error) {
      // Windows refuses file symlinks without Developer Mode or admin rights.
      if (process.platform === 'win32') {
        ctx.skip(`file symlinks need a privilege here: ${String(error)}`);
      }
      throw error;
    }
    writeResult([{ format: 'mp4', file: 'render/link.mp4' }]);
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('serves a run directory the index names through a junction', async () => {
    // Containment is checked between real paths, so the link itself is fine.
    const link = path.join(home, 'runs', 'linked');
    symlinkSync(runDir, link, 'junction');
    appendReportedRun(indexFile, { id: 'linked', runDir: link, at: 'x' });
    const sender = recordingSender();
    const streamId = open(sender, { runId: 'linked' });
    expect((await drain(sender, streamId)).equals(video)).toBe(true);
  });

  it('answers not-found for a directory', async () => {
    writeResult([{ format: 'mp4', file: 'render' }]);
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('answers not-found for the run directory itself', async () => {
    writeResult([{ format: 'mp4', file: '.' }]);
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('answers not-found for a deleted file', async () => {
    rmSync(path.join(runDir, 'render', 'ffmpeg.mp4'));
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('answers not-found for a deleted run directory', async () => {
    rmSync(runDir, { recursive: true });
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });

  it('answers not-found when result.json is not a run result', async () => {
    writeFileSync(path.join(runDir, 'result.json'), '{"renders":[]}');
    const sender = recordingSender();
    await expectNotFound(sender, open(sender));
  });
});

describe('VideoRelay: flow and ends', () => {
  beforeEach(() => {
    // 2 MiB and a bit: four windows' worth.
    video = randomBytes(4 * WINDOW_BYTES + 99);
    writeFileSync(path.join(runDir, 'render', 'ffmpeg.mp4'), video);
  });

  const unacked = (sender: Sender, streamId: string, acked: number) =>
    sender
      .of(streamId)
      .reduce((total, chunk) => total + chunk.length - FRAME_HEADER_BYTES, 0) -
    acked;

  it('never has more than 512 KiB unacknowledged, and resumes on ack', async () => {
    const sender = recordingSender();
    const streamId = open(sender);
    await until(
      () => sender.of(streamId).length === WINDOW_BYTES / CHUNK_BYTES,
      'a full window',
    );
    // Withheld acks: nothing more goes out.
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sender.of(streamId)).toHaveLength(WINDOW_BYTES / CHUNK_BYTES);
    expect(unacked(sender, streamId, 0)).toBe(WINDOW_BYTES);

    // One ack frees exactly one chunk.
    relay.handle({ type: 'video.ack', streamId, bytes: CHUNK_BYTES }, sender);
    await until(
      () => sender.of(streamId).length === WINDOW_BYTES / CHUNK_BYTES + 1,
      'one more chunk',
    );
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(unacked(sender, streamId, CHUNK_BYTES)).toBe(WINDOW_BYTES);
    expect(
      sender.messagesOf(streamId).some((m) => m.type === 'video.end'),
    ).toBe(false);

    let acked = CHUNK_BYTES;
    while (!sender.messagesOf(streamId).some((m) => m.type === 'video.end')) {
      relay.handle({ type: 'video.ack', streamId, bytes: CHUNK_BYTES }, sender);
      acked += CHUNK_BYTES;
      await new Promise((resolve) => setImmediate(resolve));
      expect(unacked(sender, streamId, acked)).toBeLessThanOrEqual(
        WINDOW_BYTES,
      );
    }
    const data = Buffer.concat(
      sender.of(streamId).map((chunk) => chunk.subarray(FRAME_HEADER_BYTES)),
    );
    expect(data.equals(video)).toBe(true);
    // `video.end` follows the last byte.
    expect(sender.messagesOf(streamId).at(-1)).toEqual({
      type: 'video.end',
      streamId,
    });
  });

  it('closes the file on video.cancel and sends nothing more', async () => {
    const sender = recordingSender();
    const streamId = open(sender);
    await until(() => sender.of(streamId).length > 0, 'a chunk');
    relay.handle({ type: 'video.cancel', streamId }, sender);
    await until(() => relay.size === 0, 'the stream ended');
    const sent = sender.chunks.length;
    relay.handle({ type: 'video.ack', streamId, bytes: WINDOW_BYTES }, sender);
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sender.chunks).toHaveLength(sent);
    expect(counts).toEqual({ open: 1, close: 1 });
    expect(relay.size).toBe(0);
    expect(logger.text()).toMatch(/bytes sent, cancelled/);
  });

  it('closes a file that was still being found when cancelled', async () => {
    const sender = recordingSender();
    const streamId = open(sender);
    relay.handle({ type: 'video.cancel', streamId }, sender);
    // The lookup finishes and opens the file after the cancel; it is closed.
    await until(() => counts.close === 1, 'the late file closed');
    expect(counts).toEqual({ open: 1, close: 1 });
    expect(sender.messages).toEqual([]);
    expect(sender.chunks).toEqual([]);
  });

  it('closes every file when the socket closes', async () => {
    const sender = recordingSender();
    const ids = [open(sender), open(sender), open(sender)];
    await until(
      () => ids.every((id) => sender.of(id).length > 0),
      'every stream sending',
    );
    expect(counts.open).toBe(3);
    relay.closeAll();
    await until(() => relay.size === 0, 'every stream ended');
    expect(counts).toEqual({ open: 3, close: 3 });
    expect(logger.text().match(/disconnected/g)).toHaveLength(3);
  });

  it('answers a fifth concurrent stream with busy', async () => {
    const sender = recordingSender();
    const ids = Array.from({ length: MAX_STREAMS }, () => open(sender));
    const fifth = open(sender);
    expect(errorOf(sender, fifth)).toEqual({
      type: 'video.error',
      streamId: fifth,
      code: 'busy',
    });
    await until(
      () => ids.every((id) => sender.of(id).length > 0),
      'four streams sending',
    );
    expect(counts.open).toBe(MAX_STREAMS);
    relay.handle({ type: 'video.cancel', streamId: ids[0] }, sender);
    await until(() => relay.size === MAX_STREAMS - 1, 'a free slot');
    const sixth = open(sender);
    await until(() => sender.of(sixth).length > 0, 'the sixth stream');
    relay.closeAll();
    await until(() => counts.close === counts.open, 'every file closed');
  });

  it('ignores a second video.open for a stream that is open', async () => {
    const sender = recordingSender();
    const streamId = open(sender);
    open(sender, { streamId, format: 'gif' });
    await until(() => sender.of(streamId).length > 0, 'a chunk');
    expect(logger.text()).toMatch(/already open/);
    expect(counts.open).toBe(1);
    expect(
      sender.messagesOf(streamId).filter((m) => m.type === 'video.head'),
    ).toHaveLength(1);
    relay.closeAll();
    await until(() => counts.close === 1, 'the file closed');
  });

  it('answers io when the file cannot be read', async () => {
    const failing: RelayFs = {
      ...countingFs(),
      open: async (file) => {
        const handle = await countingFs().open(file);
        return {
          ...handle,
          read: async () => {
            throw new Error('EIO');
          },
        };
      },
    };
    relay = new VideoRelay({
      indexFile,
      fs: failing,
      logger,
      platform: process.platform,
    });
    const sender = recordingSender();
    const streamId = open(sender);
    await until(() => errorOf(sender, streamId) !== undefined, 'video.error');
    expect(errorOf(sender, streamId)).toEqual({
      type: 'video.error',
      streamId,
      code: 'io',
    });
    expect(counts.close).toBe(counts.open);
  });

  const valid = () => ({
    streamId: randomUUID(),
    runId: RUN_ID,
    format: 'mp4',
    range: null,
  });
  it.each([
    ['no stream id', { streamId: undefined }],
    ['a stream id that is not a UUID', { streamId: 'x' }],
    ['an unknown format', { format: 'avi' }],
    ['a run id with a path in it', { runId: '../x' }],
    ['a malformed range', { range: { start: -1 } }],
    ['no range at all', { range: undefined }],
  ])('logs and ignores a video.open with %s', async (_name, fields) => {
    const sender = recordingSender();
    relay.handle({ type: 'video.open', ...valid(), ...fields }, sender);
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sender.messages).toEqual([]);
    expect(counts.open).toBe(0);
    expect(logger.text()).toMatch(/ignored a malformed video.open/);
  });

  it('ignores acks and cancels for streams it does not have', () => {
    const sender = recordingSender();
    relay.handle(
      { type: 'video.ack', streamId: randomUUID(), bytes: 5 },
      sender,
    );
    relay.handle({ type: 'video.cancel', streamId: randomUUID() }, sender);
    expect(sender.messages).toEqual([]);
    expect(logger.lines).toEqual([]);
  });
});
