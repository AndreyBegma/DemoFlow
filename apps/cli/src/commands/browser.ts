import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Io } from './io.ts';

/** Chromium is installed on first use, never at package install (spec #75, Decision 2). */
export interface BrowserDeps {
  /** Where Playwright expects Chromium (honours `PLAYWRIGHT_BROWSERS_PATH`). */
  executablePath: () => string;
  /** Runs Playwright's installer with its output on `io.stderr`; resolves to its exit code. */
  install: (io: Io) => Promise<number>;
}

export const defaultBrowserDeps: BrowserDeps = {
  executablePath: () => chromium.executablePath(),
  install: installChromium,
};

export type BrowserSetup = 'present' | 'installed' | 'failed';

export function chromiumPresent(
  deps: BrowserDeps = defaultBrowserDeps,
): boolean {
  return existsSync(deps.executablePath());
}

/**
 * Installs Chromium when it is missing, with Playwright's progress on stderr:
 * stdout stays the command's result (`--json`) or the MCP channel.
 */
export async function ensureChromium(
  io: Io,
  deps: BrowserDeps = defaultBrowserDeps,
): Promise<BrowserSetup> {
  if (chromiumPresent(deps)) return 'present';
  io.stderr('Chromium is not installed: downloading it once (~250 MB)\n');
  const code = await deps.install(io);
  if (code === 0 && chromiumPresent(deps)) {
    io.stderr('Chromium installed\n');
    return 'installed';
  }
  io.stderr(
    `Chromium could not be installed (the installer exited ${code}); run \`demoflow setup\` to retry\n`,
  );
  return 'failed';
}

/** `node <playwright>/cli.js install chromium`: the pinned Playwright's own installer. */
function installChromium(io: Io): Promise<number> {
  const manifest = createRequire(import.meta.url).resolve(
    'playwright/package.json',
  );
  const cli = path.join(path.dirname(manifest), 'cli.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => io.stderr(chunk));
    }
    child.on('error', (error) => {
      io.stderr(`${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
