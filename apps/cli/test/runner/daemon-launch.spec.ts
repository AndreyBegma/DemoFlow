import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCredentials } from '../../src/auth/credentials.ts';
import type { Io } from '../../src/commands/io.ts';
import type { HostEnvironment } from '../../src/config/platform.ts';
import type { ChildExit, SpawnRun } from '../../src/mcp/child.ts';
import { runForeground } from '../../src/runner/daemon.ts';
import { runnerPaths } from '../../src/runner/paths.ts';
import { appendReportedRun } from '../../src/runs-report/reported-runs.ts';
import { FakeClock, fakeSockets } from './fakes.ts';

const FIXTURE = path.join(
  import.meta.dirname,
  '../../../fixture/demoflow/customers.demo.json',
);

let tmp: string;
let host: HostEnvironment;

const io: Io = { stdout: () => {}, stderr: () => {} };

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'demoflow-dl-')));
  // No `CI` here: a website-started run needs reporting on.
  host = {
    platform: process.platform,
    env: {
      HOME: tmp,
      USERPROFILE: tmp,
      XDG_CONFIG_HOME: path.join(tmp, '.config'),
      APPDATA: path.join(tmp, 'AppData', 'Roaming'),
    },
    homedir: tmp,
  };
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('the daemon with a website-started run', () => {
  it('kills the child before it exits on runner stop', async () => {
    writeCredentials(host, {
      server: 'https://demoflow.test',
      token: 'dfr_daemon-launch-token',
      runnerId: 'runner-1',
    });
    const root = path.join(tmp, 'shop');
    mkdirSync(path.join(root, 'demoflow'), { recursive: true });
    writeFileSync(
      path.join(root, 'demoflow.config.json'),
      '{"baseUrl":"http://localhost:1"}',
    );
    writeFileSync(
      path.join(root, 'demoflow', 'a.demo.json'),
      readFileSync(FIXTURE, 'utf8'),
    );
    const paths = runnerPaths(host);
    appendReportedRun(paths.reportedRuns, {
      id: 'srv-0',
      runDir: path.join(tmp, 'runs', 'old'),
      at: '2026-10-23T10:00:00.000Z',
      root,
    });

    const order: string[] = [];
    const spawn: SpawnRun = () => {
      let resolve: (exit: ChildExit) => void = () => {};
      const exited = new Promise<ChildExit>((r) => {
        resolve = r;
      });
      return {
        pid: 4242,
        exited,
        kill: async () => {
          order.push('kill');
          // The child takes a moment to stop its dev server.
          await new Promise((r) => setTimeout(r, 100));
          order.push('child exited');
          resolve({ code: null, stderrTail: '' });
          await exited;
        },
      };
    };
    const { factory, sockets } = fakeSockets();
    const done = runForeground(io, {
      host,
      pid: process.pid,
      connect: factory,
      clock: new FakeClock(),
      random: () => 0.5,
      fetch: async () => new Response(null, { status: 500 }),
      spawn,
    }).then((code) => {
      order.push('daemon exited');
      return code;
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.open();
    socket.receive({
      type: 'run.start',
      requestId: '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f',
      rootPath: root,
      scenarioId: 'demoflow/a.demo.json',
    });
    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual(
        expect.objectContaining({ type: 'run.started' }),
      ),
    );
    writeFileSync(paths.stop, '');
    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual(
        expect.objectContaining({ type: 'bye' }),
      ),
    );
    socket.serverClose(1000, 'bye');
    expect(await done).toBe(0);
    expect(order).toEqual(['kill', 'child exited', 'daemon exited']);
  });

  describe('after the socket drops', () => {
    const REQUEST = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';

    async function dropped() {
      writeCredentials(host, {
        server: 'https://demoflow.test',
        token: 'dfr_daemon-launch-token',
        runnerId: 'runner-1',
      });
      const root = path.join(tmp, 'shop');
      mkdirSync(path.join(root, 'demoflow'), { recursive: true });
      writeFileSync(
        path.join(root, 'demoflow.config.json'),
        '{"baseUrl":"http://localhost:1"}',
      );
      writeFileSync(
        path.join(root, 'demoflow', 'a.demo.json'),
        readFileSync(FIXTURE, 'utf8'),
      );
      const paths = runnerPaths(host);
      appendReportedRun(paths.reportedRuns, {
        id: 'srv-0',
        runDir: path.join(tmp, 'runs', 'old'),
        at: '2026-10-23T10:00:00.000Z',
        root,
      });

      let exit: (code: ChildExit) => void = () => {};
      const spawn: SpawnRun = () => {
        const exited = new Promise<ChildExit>((r) => {
          exit = r;
        });
        return {
          pid: 4242,
          exited,
          kill: async () => {
            exit({ code: null, stderrTail: '' });
            await exited;
          },
        };
      };
      const { factory, sockets } = fakeSockets();
      const clock = new FakeClock();
      const done = runForeground(io, {
        host,
        pid: process.pid,
        connect: factory,
        clock,
        random: () => 0.5,
        fetch: async () => new Response(null, { status: 500 }),
        spawn,
      });

      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const first = sockets[0];
      if (first === undefined) throw new Error('no socket');
      first.open();
      expect(first.sent[0]).toEqual({ type: 'launches.sync', running: [] });
      first.receive({
        type: 'run.start',
        requestId: REQUEST,
        rootPath: root,
        scenarioId: 'demoflow/a.demo.json',
      });
      await vi.waitFor(() =>
        expect(first.sent).toContainEqual(
          expect.objectContaining({ type: 'run.started' }),
        ),
      );
      first.serverClose(1006);

      const reconnect = async () => {
        await clock.advance(60_000);
        const next = sockets[1];
        if (next === undefined) throw new Error('no second socket');
        next.open();
        return next;
      };
      const stop = async (socket: { serverClose(c: number): void }) => {
        writeFileSync(paths.stop, '');
        await vi.waitFor(async () => {
          await clock.advance(1);
        });
        socket.serverClose(1000);
        await done;
      };
      return { exit: () => exit({ code: 0, stderrTail: '' }), reconnect, stop };
    }

    it('announces the run its child still has, before anything else', async () => {
      const { reconnect, stop } = await dropped();
      const next = await reconnect();
      expect(next.sent[0]).toEqual({
        type: 'launches.sync',
        running: [REQUEST],
      });
      await stop(next);
    });

    it('announces nothing for a child that exited offline, and sends no run.finished on the new socket', async () => {
      const { exit, reconnect } = await dropped();
      exit();
      // Let the launcher settle: the run.finished has no socket and is dropped.
      await new Promise((r) => setTimeout(r, 50));
      const next = await reconnect();
      expect(next.sent).toEqual([{ type: 'launches.sync', running: [] }]);
    });
  });
});
