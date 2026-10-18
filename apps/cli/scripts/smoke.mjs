// Smoke-tests the package `npm publish` would ship (spec #75): packs the staged
// dist/npm/ — the same directory .woodpecker/release.yml publishes — installs
// the tarball into an empty directory with npm, and runs the installed bin.
//
//   node scripts/smoke.mjs              pack, install, --version, validate, mcp tools/list
//   node scripts/smoke.mjs --browsers   also, with an empty PLAYWRIGHT_BROWSERS_PATH:
//                                       `demoflow run` of the fixture's customers
//                                       scenario (installs Chromium, then renders)
//                                       and `demoflow setup` on another empty path.
//                                       Needs the fixture preview on :3680
//                                       (.github/scripts/serve-fixture.mjs).
//
// Plain Node, no dependencies: it runs on the `engines` floor (Node 20) and on
// Windows, where npm and the installed bin are .cmd shims.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(CLI, '../..');
const STAGED = path.join(CLI, 'dist', 'npm');
const SCENARIO = path.join(
  ROOT,
  'apps',
  'fixture',
  'demoflow',
  'customers.demo.json',
);
const WINDOWS = process.platform === 'win32';
const TOOLS = [
  'cancel_task',
  'check_project',
  'generate_demo',
  'get_task',
  'list_demos',
  'validate_scenario',
];
const browsers = process.argv.includes('--browsers');

const temporary = [];
function tempDir(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `demoflow-smoke-${name}-`));
  temporary.push(dir);
  return dir;
}

function fail(message) {
  throw new Error(message);
}

function step(title) {
  console.log(`\n== ${title}`);
}

// .cmd shims need a shell on Windows; quote what the shell would split.
function quote(arg) {
  return WINDOWS && /[\s&()^|<>"]/.test(arg) ? `"${arg}"` : arg;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args.map(quote), {
    encoding: 'utf8',
    shell: WINDOWS,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function expectExit(result, code, what) {
  if (result.status !== code) {
    fail(
      `${what}: exited ${result.status}, expected ${code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
    );
  }
}

function hasFiles(dir) {
  return existsSync(dir) && readdirSync(dir).length > 0;
}

// --- pack -----------------------------------------------------------------

function pack() {
  step(`npm pack ${path.relative(ROOT, STAGED)}`);
  if (!existsSync(path.join(STAGED, 'package.json'))) {
    fail(`${STAGED} is not staged: run the CLI's build first`);
  }
  const manifestText = readFileSync(path.join(STAGED, 'package.json'), 'utf8');
  if (
    manifestText.includes('workspace:') ||
    manifestText.includes('@demoflow/')
  ) {
    fail('the staged package.json references the workspace');
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.private) fail('the staged package.json is private');

  const out = tempDir('pack');
  const result = run('npm', ['pack', '--json', '--pack-destination', out], {
    cwd: STAGED,
  });
  expectExit(result, 0, 'npm pack');
  const [packed] = JSON.parse(result.stdout);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    manifest.bin.demoflow,
    'fonts/Inter-Regular.ttf',
    'fonts/Inter-SemiBold.ttf',
    'fonts/OFL.txt',
  ]) {
    if (!files.has(required)) fail(`the tarball lacks ${required}`);
  }
  console.log(
    `${packed.filename}: ${packed.files.length} files, ${packed.size} bytes`,
  );
  return {
    tarball: path.join(out, packed.filename),
    version: manifest.version,
  };
}

// --- install ----------------------------------------------------------------

function install(tarball) {
  step('npm install <tarball> into an empty directory');
  const dir = tempDir('install');
  // A package.json of its own, so npm does not walk up into another project.
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demoflow-smoke', private: true }, null, 2)}\n`,
  );
  const result = run('npm', ['install', '--no-fund', '--no-audit', tarball], {
    cwd: dir,
  });
  expectExit(result, 0, 'npm install');
  const bin = path.join(
    dir,
    'node_modules',
    '.bin',
    WINDOWS ? 'demoflow.cmd' : 'demoflow',
  );
  if (!existsSync(bin)) fail(`npm did not link the bin: ${bin}`);
  return { dir, bin };
}

// --- commands ---------------------------------------------------------------

function version(bin, cwd, expected) {
  step('demoflow --version');
  const result = run(bin, ['--version'], { cwd });
  expectExit(result, 0, 'demoflow --version');
  if (result.stdout.trim() !== expected) {
    fail(
      `demoflow --version printed ${result.stdout.trim()}, expected ${expected}`,
    );
  }
  console.log(result.stdout.trim());
}

function validate(bin, cwd) {
  step('demoflow validate <fixture>');
  const result = run(bin, ['validate', SCENARIO], { cwd });
  expectExit(result, 0, 'demoflow validate');
  console.log(result.stdout.trim());
}

/** `initialize`, then `tools/list`, over newline-delimited JSON-RPC on stdio. */
function toolsList(bin, cwd) {
  step('demoflow mcp: tools/list');
  return new Promise((resolve, reject) => {
    const child = spawn(quote(bin), ['mcp'], {
      cwd,
      shell: WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(`demoflow mcp did not answer in time\n--- stderr\n${stderr}`),
      );
    }, 60_000);
    const send = (message) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list' });
        } else if (message.id === 2) {
          clearTimeout(timer);
          // Closing stdin is how a client ends the server.
          child.stdin.end();
          const names = (message.result?.tools ?? [])
            .map((tool) => tool.name)
            .sort();
          if (JSON.stringify(names) !== JSON.stringify(TOOLS)) {
            reject(new Error(`tools/list returned ${names.join(', ')}`));
            return;
          }
          console.log(names.join(', '));
          child.on('close', () => resolve());
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'demoflow-smoke', version: '0' },
      },
    });
  });
}

function runWithoutChromium(bin) {
  step('demoflow run, with no Chromium installed');
  const browsersPath = tempDir('browsers-run');
  const out = tempDir('out');
  const result = run(bin, ['run', SCENARIO, '--out', out, '--json'], {
    cwd: path.dirname(SCENARIO),
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
  });
  process.stderr.write(result.stderr);
  expectExit(result, 0, 'demoflow run');
  if (!result.stderr.includes('Chromium is not installed')) {
    fail('demoflow run did not announce the Chromium download');
  }
  if (!hasFiles(browsersPath)) fail('demoflow run installed nothing');
  const runResult = JSON.parse(result.stdout);
  console.log(
    `run ${runResult.runId ?? '?'}: ${result.stdout.length} bytes of JSON`,
  );
}

function setupWithoutChromium(bin, cwd) {
  step('demoflow setup, with no Chromium installed');
  const browsersPath = tempDir('browsers-setup');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };
  const first = run(bin, ['setup'], { cwd, env });
  process.stderr.write(first.stderr);
  expectExit(first, 0, 'demoflow setup');
  if (!first.stderr.includes('Chromium is not installed')) {
    fail('demoflow setup did not announce the Chromium download');
  }
  const again = run(bin, ['setup'], { cwd, env });
  expectExit(again, 0, 'demoflow setup (again)');
  if (!again.stdout.startsWith('Chromium is installed')) {
    fail(`a second demoflow setup printed: ${again.stdout}`);
  }
  console.log(again.stdout.trim());
}

try {
  const { tarball, version: expected } = pack();
  const { dir, bin } = install(tarball);
  version(bin, dir, expected);
  validate(bin, dir);
  await toolsList(bin, dir);
  if (browsers) {
    runWithoutChromium(bin);
    setupWithoutChromium(bin, dir);
  }
  console.log('\nsmoke: ok');
} catch (error) {
  console.error(
    `\nsmoke: FAILED\n${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
