// `demoflow runner --foreground` without the rest of the CLI, so the process
// tests can spawn the daemon from source.
import { processIo } from '../../src/commands/io.ts';
import { currentHost } from '../../src/config/platform.ts';
import { defaultDaemonDeps, runForeground } from '../../src/runner/daemon.ts';

process.exitCode = await runForeground(
  processIo,
  defaultDaemonDeps(currentHost()),
);
