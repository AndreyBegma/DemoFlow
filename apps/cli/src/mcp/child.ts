import { type ChildProcess, spawn } from 'node:child_process';
import { CLI_ENTRY } from '../entry.ts';

/** How long a run gets to close its browser after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL = 8 * 1024;
const STDOUT_LINE_MAX = 8 * 1024;

export interface ChildExit {
  code: number | null;
  /** The last few KiB of stderr: the message when no `result.json` was written. */
  stderrTail: string;
}

/** One `demoflow run` child. */
export interface RunChild {
  readonly pid: number | undefined;
  /** Resolves once the child has exited and its pipes are closed; never rejects. */
  readonly exited: Promise<ChildExit>;
  /** Kills the child and what it started; resolves once it has exited. */
  kill(): Promise<void>;
}

export interface SpawnRunOptions {
  /**
   * How long `kill()` waits after SIGTERM before SIGKILL; 5 s when absent.
   * The runner daemon passes more, so the dev server stops too (spec 248).
   */
  killGraceMs?: number;
  /**
   * Called with each line the child prints on stdout (UTF-8, `\n` or `\r\n`
   * stripped; a line over 8 KiB is dropped). Without it stdout is discarded.
   * A throwing callback is ignored.
   */
  onStdoutLine?: (line: string) => void;
}

export type SpawnRun = (
  args: string[],
  cwd: string,
  options?: SpawnRunOptions,
) => RunChild;

/**
 * `node <cli> run …` through `process.execPath`, so it works from npx, a global
 * install and the workspace alike. Stdout is never inherited: it is the MCP
 * channel. On POSIX the child leads its own process group, so a kill reaches
 * FFmpeg too (Playwright closes its own browser on SIGTERM).
 */
export const spawnRun: SpawnRun = (args, cwd, options) =>
  spawnNode(CLI_ENTRY, args, cwd, options);

/** `spawnRun` for any Node entry point; tests run a stand-in through it. */
export function spawnNode(
  entry: string,
  args: string[],
  cwd: string,
  options: SpawnRunOptions = {},
): RunChild {
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let stderr = '';
  if (options.onStdoutLine === undefined) {
    child.stdout?.resume();
  } else {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', lineReader(options.onStdoutLine));
  }
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  let done = false;
  const exited = new Promise<ChildExit>((resolve) => {
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      if (child.pid === undefined) {
        done = true;
        resolve({ code: null, stderrTail: stderr });
      }
    });
    child.on('close', (code) => {
      done = true;
      resolve({ code, stderrTail: stderr });
    });
  });
  return {
    pid: child.pid,
    exited,
    kill: async () => {
      if (done) return;
      killTree(child, 'SIGTERM');
      const timer = setTimeout(() => killTree(child, 'SIGKILL'), graceMs);
      await exited;
      clearTimeout(timer);
      // Anything left in the group (an FFmpeg that ignored SIGTERM) goes too;
      // on Windows `taskkill /T` already took the whole tree.
      if (process.platform !== 'win32') killTree(child, 'SIGKILL');
    },
  };
}

/**
 * Splits chunks into lines. A line over `STDOUT_LINE_MAX` is dropped up to its
 * next newline, so the final `--json` result cannot grow the buffer.
 */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = '';
  let dropping = false;
  const deliver = (line: string): void => {
    if (line.length > STDOUT_LINE_MAX) return;
    try {
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      // A callback's failure must not stop the child's output being read.
    }
  };
  return (chunk) => {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline === -1) break;
      const head = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (dropping) dropping = false;
      else deliver(pending + head);
      pending = '';
    }
    if (dropping) return;
    pending += rest;
    if (pending.length > STDOUT_LINE_MAX) {
      pending = '';
      dropping = true;
    }
  };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // TerminateProcess on the whole tree: the browser and FFmpeg with it.
    const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}
