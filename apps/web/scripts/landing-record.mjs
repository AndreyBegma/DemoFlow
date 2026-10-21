// Re-records the landing page's demo video (spec #137).
//
//   bun run landing:record
//
// Builds the CLI and the fixture app, serves the fixture preview on :3680, runs
// `demoflow run` on apps/fixture/demoflow/landing.demo.json from a temporary
// project (its own config adds the outro card, so the fixture's config stays
// untouched), then copies the MP4 and cuts the poster and the Open Graph image
// into apps/web/public/demo/. Plain Node: Linux and macOS.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const CLI_BIN = path.join(ROOT, 'apps/cli/dist/main.js');
const SCENARIO = path.join(ROOT, 'apps/fixture/demoflow/landing.demo.json');
const SERVE_FIXTURE = path.join(ROOT, '.github/scripts/serve-fixture.mjs');
const OUT_DIR = path.join(ROOT, 'apps/web/public/demo');
const RUN_ID = 'landing';
const MAX_BYTES = 8 * 1024 * 1024;
// The intro card is on screen from 0 to 2 s; this frame is past its fade-in.
const POSTER_AT_SECONDS = '1';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}

function ffmpegPath() {
  const fromRenderer = createRequire(
    path.join(ROOT, 'packages/renderer/package.json'),
  );
  return fromRenderer('ffmpeg-static');
}

const project = mkdtempSync(path.join(tmpdir(), 'demoflow-landing-'));
let fixtureUp = false;
try {
  // Turbo builds the packages the CLI depends on first, as CI does.
  run(
    'bun',
    ['run', 'build', '--filter=@demoflow/cli', '--filter=@demoflow/fixture'],
    { cwd: ROOT },
  );
  run('node', [SERVE_FIXTURE, 'start'], { cwd: ROOT });
  fixtureUp = true;

  mkdirSync(path.join(project, 'demoflow'));
  copyFileSync(SCENARIO, path.join(project, 'demoflow/landing.demo.json'));
  writeFileSync(
    path.join(project, 'demoflow.config.json'),
    JSON.stringify({
      baseUrl: 'http://localhost:3680',
      render: {
        cards: { outro: { title: 'DemoFlow', cta: 'npx demoflow' } },
      },
    }),
  );

  run(
    'node',
    [
      CLI_BIN,
      'run',
      'demoflow/landing.demo.json',
      '--run-id',
      RUN_ID,
      '--out',
      path.join(project, 'artifacts'),
    ],
    {
      cwd: project,
      env: { ...process.env, FIXTURE_PASSWORD: 'correct-horse-battery' },
    },
  );

  const runDir = path.join(project, 'artifacts/runs', RUN_ID);
  const result = JSON.parse(readFileSync(path.join(runDir, 'result.json')));
  // `completed`: every stage passed (`storage` is skipped without a Runner).
  if (result.status !== 'completed') {
    throw new Error(`the run did not pass: ${result.status}`);
  }
  const mp4 = result.renders.find((render) => render.format === 'mp4');
  if (!mp4) throw new Error('the run rendered no MP4');
  const source = path.join(runDir, mp4.file);
  if (statSync(source).size > MAX_BYTES) {
    throw new Error(`the MP4 is over ${MAX_BYTES / 1024 / 1024} MB`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(source, path.join(OUT_DIR, 'landing.mp4'));
  const ffmpeg = ffmpegPath();
  const frame = (name, filter) =>
    run(ffmpeg, [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      POSTER_AT_SECONDS,
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      filter,
      path.join(OUT_DIR, name),
    ]);
  frame('landing-poster.png', 'scale=1920:1080');
  frame('og.png', 'scale=1200:-2,crop=1200:630');
  const bytes = statSync(path.join(OUT_DIR, 'landing.mp4')).size;
  console.log(`landing.mp4: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
} finally {
  if (fixtureUp) run('node', [SERVE_FIXTURE, 'stop'], { cwd: ROOT });
  rmSync(project, { recursive: true, force: true });
}
