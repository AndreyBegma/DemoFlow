// A stand-in for `demoflow run` with a dev server: it starts a grandchild in
// its own process group on POSIX, which a group kill does not reach, and
// stops it on SIGTERM, as `app/dev-server.ts` does.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (pidFile === undefined) throw new Error('usage: tree-child <pid file>');
const grandchild = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  },
);
writeFileSync(
  pidFile,
  JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
);
process.on('SIGTERM', () => {
  grandchild.once('exit', () => process.exit(0));
  grandchild.kill('SIGTERM');
});
setInterval(() => {}, 1000);
