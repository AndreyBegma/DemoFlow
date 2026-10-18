import { rm } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromiumPresent } from '../commands/browser.ts';
import type { Io } from '../commands/io.ts';
import { readResult } from '../commands/settle.ts';
import { currentHost } from '../config/index.ts';
import { spawnRun } from './child.ts';
import { createMcpServer } from './server.ts';
import { TaskQueue } from './tasks.ts';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * `demoflow mcp`: serves until stdin closes or a shutdown signal arrives, then
 * kills the running child and leaves — queued and running tasks die with the
 * server, no orphans (spec #68, Decision 8). Stdout carries MCP only.
 */
export async function mcpCommand(io: Io): Promise<number> {
  const queue = new TaskQueue({
    spawn: spawnRun,
    readResult,
    removeFile: (file) => rm(file, { force: true }),
    log: (line) => io.stderr(`demoflow mcp: ${line}\n`),
  });
  const server = createMcpServer({
    queue,
    host: currentHost(),
    cwd: process.cwd(),
  });
  const transport = new StdioServerTransport();

  let stop: (reason: string) => void = () => undefined;
  const stopped = new Promise<string>((resolve) => {
    stop = resolve;
  });
  const onSignal = (signal: NodeJS.Signals) => stop(signal);
  const onEnd = () => stop('stdin closed');
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
  process.stdin.on('end', onEnd);
  process.stdin.on('close', onEnd);
  server.onclose = () => stop('transport closed');

  await server.connect(transport);
  io.stderr('demoflow mcp: serving on stdio\n');
  // No download at startup: the first generate_demo installs it through its run.
  if (!chromiumPresent()) {
    io.stderr(
      'demoflow mcp: Chromium is not installed; the first generate_demo downloads it (or run `demoflow setup`)\n',
    );
  }
  const reason = await stopped;

  for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal);
  process.stdin.off('end', onEnd);
  process.stdin.off('close', onEnd);
  await queue.close();
  await server.close();
  // Nothing else holds the event loop: the process leaves on its own.
  process.stdin.destroy();
  io.stderr(`demoflow mcp: stopped (${reason})\n`);
  return 0;
}
