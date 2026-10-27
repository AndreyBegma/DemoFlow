import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Chapter, RenderFormat, RunResult } from '@demoflow/core';
import { runFfmpeg } from '@demoflow/renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posterPath } from '../../src/runner/share/files.ts';
import {
  makePoster,
  POSTER_MAX_BYTES,
  type PosterRequest,
  posterArgs,
  posterAtMs,
} from '../../src/runner/share/poster.ts';
import {
  DESCRIPTION_MAX_LENGTH,
  SharePreparer,
} from '../../src/runner/share/prepare.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { memoryLogger } from './fakes.ts';

const RUN_ID = 'srv-run-1';
const SCENARIO = 'demoflow/a.demo.json';

let base: string;
let root: string;
let runDir: string;
let indexFile: string;
let logger: ReturnType<typeof memoryLogger>;
let posters: PosterRequest[];
let posterSize: number | Error;

function writeResult(
  renders: Array<{
    format: RenderFormat;
    file: string;
    chapters?: Chapter[];
    durationMs?: number;
  }>,
  scenarioId = SCENARIO,
): void {
  const done = { status: 'passed' } as const;
  const result: RunResult = {
    schemaVersion: 1,
    runId: 'local-run',
    scenarioId,
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
      durationMs: 4000,
      sizeBytes: 1,
      width: 1280,
      height: 720,
      fps: 30,
      ...render,
    })),
    warnings: [],
  };
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result));
}

function writeScenario(description?: string, file = SCENARIO): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({
      schemaVersion: 1,
      name: 'A',
      ...(description === undefined ? {} : { description }),
      steps: [{ action: 'navigate', path: '/' }],
    }),
  );
}

function preparer(): SharePreparer {
  return new SharePreparer({
    indexFile,
    logger,
    platform: process.platform,
    makePoster: async (request) => {
      posters.push(request);
      if (posterSize instanceof Error) throw posterSize;
      return posterSize;
    },
  });
}

/** Sends one `share.prepare` and waits for its answer. */
async function prepare(
  message: Record<string, unknown> = {},
  share = preparer(),
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    share.handle(
      {
        type: 'share.prepare',
        requestId: '2f1f6d0e-7a53-4c1b-9d57-0c1f6f1d2a11',
        runId: RUN_ID,
        format: 'mp4',
        ...message,
      },
      { send: resolve },
    );
  });
}

beforeEach(() => {
  // The preparer resolves with the native realpath, which expands the 8.3
  // short names of a Windows temp dir (RUNNER~1); the JS one does not.
  base = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-share-')),
  );
  root = path.join(base, 'project');
  runDir = path.join(base, 'home', 'runs', 'local-run');
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(runDir, 'renders'), { recursive: true });
  indexFile = path.join(base, 'runner', 'reported-runs.jsonl');
  appendReportedRun(indexFile, {
    id: RUN_ID,
    runDir,
    at: '2026-10-22T10:00:01.000Z',
    root,
  });
  writeFileSync(path.join(runDir, 'renders', 'demo.mp4'), 'mp4 bytes');
  logger = memoryLogger();
  posters = [];
  posterSize = 1234;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('SharePreparer (spec 349, Decision 2)', () => {
  it('answers with the description, the chapters and the poster size, and no path', async () => {
    const chapters = [
      { title: 'Customers', atMs: 0 },
      { title: 'Invoices', atMs: 4200 },
    ];
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4', chapters }]);
    writeScenario('Create a customer, then bill them.');
    const answer = await prepare();
    expect(answer).toEqual({
      type: 'share.prepared',
      requestId: '2f1f6d0e-7a53-4c1b-9d57-0c1f6f1d2a11',
      description: 'Create a customer, then bill them.',
      chapters,
      posterSize: 1234,
    });
    expect(posters).toEqual([
      {
        render: path.join(runDir, 'renders', 'demo.mp4'),
        poster: posterPath(runDir, 'mp4', process.platform),
        durationMs: 4000,
        platform: process.platform,
      },
    ]);
    expect(logger.text()).toContain(`share ${RUN_ID} mp4: prepared`);
    expect(logger.text()).not.toContain(base);
  });

  it('answers chapters [] and no description for an old render and a gone scenario', async () => {
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    const answer = await prepare();
    expect(answer).toEqual({
      type: 'share.prepared',
      requestId: '2f1f6d0e-7a53-4c1b-9d57-0c1f6f1d2a11',
      chapters: [],
      posterSize: 1234,
    });
  });

  it('cuts a long description to the API limit', async () => {
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    writeScenario('x'.repeat(DESCRIPTION_MAX_LENGTH + 50));
    const answer = await prepare();
    expect(answer.description).toBe('x'.repeat(DESCRIPTION_MAX_LENGTH));
  });

  it('reads no description for a run without a project root', async () => {
    rmSync(indexFile);
    appendReportedRun(indexFile, { id: RUN_ID, runDir, at: '' });
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    writeScenario('Hidden.');
    expect((await prepare()).description).toBeUndefined();
  });

  it('reads no description from outside the project', async () => {
    writeFileSync(
      path.join(base, 'outside.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'O',
        description: 'Outside.',
        steps: [{ action: 'navigate', path: '/' }],
      }),
    );
    writeResult(
      [{ format: 'mp4', file: 'renders/demo.mp4' }],
      '../outside.json',
    );
    expect((await prepare()).description).toBeUndefined();
  });

  it('answers not-found for an unreported run or an unreadable result', async () => {
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    expect(await prepare({ runId: 'srv-other' })).toEqual({
      type: 'share.error',
      requestId: '2f1f6d0e-7a53-4c1b-9d57-0c1f6f1d2a11',
      code: 'not-found',
    });
    writeFileSync(path.join(runDir, 'result.json'), '{ not json');
    expect((await prepare()).code).toBe('not-found');
    writeFileSync(path.join(runDir, 'result.json'), '{}');
    expect((await prepare()).code).toBe('not-found');
    expect(posters).toEqual([]);
  });

  it('answers no-render for an unrendered format, a missing file or one outside the run', async () => {
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    expect((await prepare({ format: 'gif' })).code).toBe('no-render');

    writeResult([{ format: 'mp4', file: 'renders/gone.mp4' }]);
    expect((await prepare()).code).toBe('no-render');

    writeFileSync(path.join(base, 'secret.mp4'), 'secret');
    writeResult([{ format: 'mp4', file: '../../../secret.mp4' }]);
    expect((await prepare()).code).toBe('no-render');

    if (process.platform !== 'win32') {
      symlinkSync(
        path.join(base, 'secret.mp4'),
        path.join(runDir, 'renders', 'link.mp4'),
      );
      writeResult([{ format: 'mp4', file: 'renders/link.mp4' }]);
      expect((await prepare()).code).toBe('no-render');
    }
    expect(posters).toEqual([]);
    expect(logger.text()).toContain(`share ${RUN_ID} gif: no-render`);
  });

  it('answers io when the poster cannot be made', async () => {
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    posterSize = new Error('ffmpeg exited with 1');
    expect((await prepare()).code).toBe('io');
    expect(logger.text()).toContain(`share ${RUN_ID} mp4: io`);
    expect(logger.text()).not.toContain('ffmpeg exited');
  });

  it('ignores a malformed share.prepare', () => {
    const share = preparer();
    const sent: unknown[] = [];
    for (const message of [
      { requestId: 'not-a-uuid', runId: RUN_ID, format: 'mp4' },
      { requestId: randomUUID(), runId: '../x', format: 'mp4' },
      { requestId: randomUUID(), runId: RUN_ID, format: 'avi' },
      { requestId: randomUUID(), format: 'mp4' },
    ]) {
      share.handle(
        { type: 'share.prepare', ...message },
        { send: (m) => sent.push(m) },
      );
    }
    expect(sent).toEqual([]);
    expect(logger.text()).toMatch(/ignored a malformed share.prepare/);
  });

  it('makes one poster for two shares of the same render at once', async () => {
    writeResult([{ format: 'mp4', file: 'renders/demo.mp4' }]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const share = new SharePreparer({
      indexFile,
      logger,
      platform: process.platform,
      makePoster: async (request) => {
        posters.push(request);
        await gate;
        return 1234;
      },
    });
    setTimeout(release, 200);
    const answers = await Promise.all([
      prepare({}, share),
      prepare({ requestId: randomUUID() }, share),
    ]);
    expect(answers.map((answer) => answer.type)).toEqual([
      'share.prepared',
      'share.prepared',
    ]);
    expect(posters).toHaveLength(1);
  });
});

/** The width of a baseline or progressive JPEG, from its SOF marker. */
function jpegWidth(bytes: Buffer): number {
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  let at = 2;
  while (at < bytes.length) {
    const marker = bytes[at + 1] ?? 0;
    const length = bytes.readUInt16BE(at + 2);
    if (marker === 0xc0 || marker === 0xc2) return bytes.readUInt16BE(at + 7);
    at += 2 + length;
  }
  throw new Error('no SOF marker');
}

describe('the poster (spec 349, Decision 3)', () => {
  it('is taken at min(1500, durationMs / 2), after -i, at most 1280 wide', () => {
    expect(posterAtMs(10_000)).toBe(1500);
    expect(posterAtMs(1001)).toBe(500);
    expect(posterAtMs(0)).toBe(0);
    const args = posterArgs('in.gif', 'out.jpg', 500);
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));
    expect(args).toContain('0.500');
    expect(args).toContain("scale='min(1280,iw)':-2");
    expect(args.slice(-3)).toEqual(['-q:v', '4', 'out.jpg']);
  });

  it.each([
    ['mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
    ['gif', []],
  ] as const)(
    'makes a JPEG at most 1280 px wide from a %s render',
    async (format, codec) => {
      const render = path.join(runDir, 'renders', `demo.${format}`);
      await runFfmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1920x1080:rate=10:duration=1',
        ...codec,
        render,
      ]);
      const poster = posterPath(runDir, format, process.platform);
      const size = await makePoster({
        render,
        poster,
        durationMs: 1000,
        platform: process.platform,
      });
      const bytes = readFileSync(poster);
      expect(size).toBe(bytes.length);
      expect(size).toBeLessThanOrEqual(POSTER_MAX_BYTES);
      expect(jpegWidth(bytes)).toBe(1280);
    },
    60_000,
  );

  it('reuses a poster newer than its render, and remakes an older one', async () => {
    const render = path.join(runDir, 'renders', 'demo.mp4');
    const poster = posterPath(runDir, 'mp4', process.platform);
    const request = {
      render,
      poster,
      durationMs: 4000,
      platform: process.platform,
    };
    const runs: string[][] = [];
    const ffmpeg = async (args: readonly string[]) => {
      runs.push([...args]);
      writeFileSync(args.at(-1) ?? '', 'jpeg');
    };
    expect(await makePoster(request, ffmpeg)).toBe(4);
    expect(runs).toHaveLength(1);
    // Written to a temporary file, then renamed.
    expect(runs[0]?.at(-1)).toBe(poster.replace(/\.jpg$/, '.tmp.jpg'));

    const later = new Date(statSync(render).mtimeMs + 10_000);
    utimesSync(poster, later, later);
    expect(await makePoster(request, ffmpeg)).toBe(4);
    expect(runs).toHaveLength(1);

    const newer = new Date(later.getTime() + 10_000);
    utimesSync(render, newer, newer);
    await makePoster(request, ffmpeg);
    expect(runs).toHaveLength(2);
  });

  it('rejects a poster over 1 MiB and leaves no temporary file when FFmpeg fails', async () => {
    const render = path.join(runDir, 'renders', 'demo.mp4');
    const poster = posterPath(runDir, 'mp4', process.platform);
    const request = {
      render,
      poster,
      durationMs: 4000,
      platform: process.platform,
    };
    await expect(
      makePoster(request, async (args) => {
        writeFileSync(args.at(-1) ?? '', Buffer.alloc(POSTER_MAX_BYTES + 1));
      }),
    ).rejects.toThrow(/bytes/);

    rmSync(poster);
    await expect(
      makePoster(request, async (args) => {
        writeFileSync(args.at(-1) ?? '', 'half');
        throw new Error('ffmpeg exited with 1');
      }),
    ).rejects.toThrow(/exited/);
    expect(() => statSync(poster.replace(/\.jpg$/, '.tmp.jpg'))).toThrow();
    expect(() => statSync(poster)).toThrow();
  });
});
