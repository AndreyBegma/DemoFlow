import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserDeps,
  ensureChromium,
} from '../../src/commands/browser.ts';
import { EXIT_STAGE_FAILED } from '../../src/commands/errors.ts';
import type { Io } from '../../src/commands/io.ts';
import { setupCommand } from '../../src/commands/setup.ts';

function captureIo(): Io & { out: string; err: string } {
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

let dir: string;
let executable: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'demoflow-browser-'));
  executable = path.join(dir, 'chrome');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An installer that writes the executable (or not) and exits with `code`. */
function deps(
  code: number,
  writes = code === 0,
): BrowserDeps & { calls: number } {
  const browser = {
    calls: 0,
    executablePath: () => executable,
    install: async (io: Io) => {
      browser.calls += 1;
      io.stderr('|■■■■■■■■| 100% of 170 MiB\n');
      if (writes) await writeFile(executable, '');
      return code;
    },
  };
  return browser;
}

describe('ensureChromium', () => {
  it('does nothing when Chromium is there', async () => {
    await writeFile(executable, '');
    const io = captureIo();
    const browser = deps(0);
    expect(await ensureChromium(io, browser)).toBe('present');
    expect(browser.calls).toBe(0);
    expect(io.err).toBe('');
  });

  it('installs a missing Chromium with progress on stderr, never stdout', async () => {
    const io = captureIo();
    const browser = deps(0);
    expect(await ensureChromium(io, browser)).toBe('installed');
    expect(browser.calls).toBe(1);
    expect(io.err).toContain('Chromium is not installed');
    expect(io.err).toContain('100% of 170 MiB');
    expect(io.out).toBe('');
  });

  it('fails when the installer fails', async () => {
    const io = captureIo();
    expect(await ensureChromium(io, deps(1))).toBe('failed');
    expect(io.err).toContain('the installer exited 1');
    expect(io.err).toContain('demoflow setup');
  });

  it('fails when the installer succeeds but Chromium is still missing', async () => {
    const io = captureIo();
    expect(await ensureChromium(io, deps(0, false))).toBe('failed');
  });
});

describe('demoflow setup', () => {
  it('reports an installed Chromium without downloading', async () => {
    await writeFile(executable, '');
    const io = captureIo();
    const browser = deps(0);
    expect(await setupCommand(io, browser)).toBe(0);
    expect(browser.calls).toBe(0);
    expect(io.out).toBe(`Chromium is installed: ${executable}\n`);
  });

  it('installs a missing Chromium', async () => {
    const io = captureIo();
    expect(await setupCommand(io, deps(0))).toBe(0);
    expect(io.out).toBe(`Chromium installed: ${executable}\n`);
  });

  it('exits 3 when the install fails', async () => {
    const io = captureIo();
    expect(await setupCommand(io, deps(1))).toBe(EXIT_STAGE_FAILED);
    expect(io.out).toBe('');
  });
});
