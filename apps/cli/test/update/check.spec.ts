import { describe, expect, it, vi } from 'vitest';
import {
  REGISTRY_URL,
  type SpawnResult,
  type UpdateDeps,
  withUpdateCheck,
} from '../../src/update/check.ts';
import type { Install } from '../../src/update/install.ts';

interface Fake {
  deps: UpdateDeps;
  fetch: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  stored: { value: string | undefined };
  err: () => string;
}

function registry(version: string): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ name: 'demoflow', version }), {
      status: 200,
    });
}

function fake(
  options: {
    latest?: string;
    current?: string;
    install?: Install;
    answer?: string | null;
    spawn?: SpawnResult;
    fetch?: typeof fetch;
    env?: Record<string, string>;
    tty?: Partial<UpdateDeps['tty']>;
    skip?: string;
  } = {},
): Fake {
  let stderr = '';
  const stored = { value: options.skip };
  const fetchFn = vi.fn(options.fetch ?? registry(options.latest ?? '0.2.0'));
  const ask = vi.fn(async () =>
    options.answer === undefined ? '' : options.answer,
  );
  const spawn = vi.fn(async () => options.spawn ?? { code: 0 });
  const deps: UpdateDeps = {
    env: options.env ?? {},
    tty: { stdin: true, stdout: true, stderr: true, ...options.tty },
    current: () => options.current ?? '0.1.0',
    install: () => options.install ?? { kind: 'global', manager: 'npm' },
    fetch: fetchFn as unknown as typeof fetch,
    ask,
    spawn,
    store: {
      read: () => stored.value,
      write: (version) => {
        stored.value = version;
      },
    },
    stderr: (text) => {
      stderr += text;
    },
    timeoutMs: 50,
    graceMs: 20,
  };
  return { deps, fetch: fetchFn, ask, spawn, stored, err: () => stderr };
}

const run =
  (code = 0) =>
  async () =>
    code;

describe('the update check', () => {
  it('asks after the command when npm has a newer version, and Enter installs it', async () => {
    const f = fake();
    const order: string[] = [];
    f.ask.mockImplementation(async () => {
      order.push('ask');
      return '';
    });
    const code = await withUpdateCheck(
      ['run', 'a.demo.json'],
      async () => {
        order.push('command');
        return 0;
      },
      f.deps,
    );
    expect(code).toBe(0);
    expect(order).toEqual(['command', 'ask']);
    expect(f.fetch).toHaveBeenCalledWith(REGISTRY_URL, expect.anything());
    expect(f.ask).toHaveBeenCalledWith(
      'demoflow 0.2.0 is available (you have 0.1.0). Update now? [Y/n/never] ',
    );
    expect(f.spawn).toHaveBeenCalledWith([
      'npm',
      'install',
      '-g',
      'demoflow@0.2.0',
    ]);
    expect(f.err()).toContain('Updated to 0.2.0. Re-run demoflow to use it.');
  });

  it('starts the request before the command finishes', async () => {
    const f = fake();
    await withUpdateCheck(
      ['validate', 'a'],
      async () => {
        expect(f.fetch).toHaveBeenCalledTimes(1);
        return 0;
      },
      f.deps,
    );
  });

  it.each([
    ['bun', ['bun', 'add', '-g', 'demoflow@0.2.0']],
    ['pnpm', ['pnpm', 'add', '-g', 'demoflow@0.2.0']],
    ['yarn', ['yarn', 'global', 'add', 'demoflow@0.2.0']],
  ] as const)('installs with %s when %s installed it', async (manager, command) => {
    const f = fake({ install: { kind: 'global', manager }, answer: 'y' });
    await withUpdateCheck(['validate', 'a'], run(), f.deps);
    expect(f.spawn).toHaveBeenCalledWith(command);
  });

  it('does nothing on n', async () => {
    const f = fake({ answer: 'n' });
    await withUpdateCheck(['validate', 'a'], run(), f.deps);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.stored.value).toBeUndefined();
  });

  it.each([
    ['the same version', '0.1.0', '0.1.0'],
    ['an older version', '0.1.0', '0.2.0'],
    ['a prerelease', '0.3.0-beta.1', '0.1.0'],
  ])('does not ask for %s', async (_name, latest, current) => {
    const f = fake({ latest, current });
    await withUpdateCheck(['validate', 'a'], run(), f.deps);
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.err()).toBe('');
  });

  it.each<[string, string[], Parameters<typeof fake>[0]]>([
    ['stdin is not a TTY', ['validate', 'a'], { tty: { stdin: false } }],
    ['stdout is not a TTY', ['run', 'a', '--json'], { tty: { stdout: false } }],
    ['stderr is not a TTY', ['validate', 'a'], { tty: { stderr: false } }],
    ['CI is set', ['validate', 'a'], { env: { CI: 'true' } }],
    [
      'DEMOFLOW_NO_UPDATE_CHECK=1',
      ['validate', 'a'],
      { env: { DEMOFLOW_NO_UPDATE_CHECK: '1' } },
    ],
    ['the command is mcp', ['mcp'], {}],
    ['it is the runner daemon', ['runner', '--foreground'], {}],
    ['it follows the runner log', ['runner', 'logs', '-f'], {}],
    [
      'it follows the runner log (long flag)',
      ['runner', 'logs', '--follow'],
      {},
    ],
    ['it runs from npx', ['validate', 'a'], { install: { kind: 'ephemeral' } }],
    [
      'it runs from the checkout',
      ['validate', 'a'],
      { install: { kind: 'source' } },
    ],
  ])('makes no request when %s', async (_name, argv, options) => {
    const f = fake(options);
    const code = await withUpdateCheck(argv, run(3), f.deps);
    expect(code).toBe(3);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.err()).toBe('');
  });

  it('checks for runner commands that end', async () => {
    const f = fake();
    await withUpdateCheck(['runner', 'status'], run(), f.deps);
    expect(f.fetch).toHaveBeenCalled();
  });

  it('is silent and keeps the exit code on a timeout', async () => {
    const f = fake({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    });
    const started = Date.now();
    const code = await withUpdateCheck(['validate', 'a'], run(7), f.deps);
    expect(code).toBe(7);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.err()).toBe('');
    expect(f.ask).not.toHaveBeenCalled();
  });

  it('abandons a request still running after the grace period', async () => {
    let signal: AbortSignal | undefined;
    const f = fake({
      fetch: (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      },
    });
    f.deps.timeoutMs = 60_000;
    await withUpdateCheck(['validate', 'a'], run(), f.deps);
    expect(signal?.aborted).toBe(true);
    expect(f.err()).toBe('');
  });

  it.each<[string, typeof fetch]>([
    [
      'a network error',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['a 500', async () => new Response('nope', { status: 500 })],
    ['a body that is not JSON', async () => new Response('<html>')],
    ['a body with no version', async () => new Response('{}')],
  ])('is silent and keeps the exit code on %s', async (_name, fetchFn) => {
    const f = fake({ fetch: fetchFn });
    const code = await withUpdateCheck(['validate', 'a'], run(4), f.deps);
    expect(code).toBe(4);
    expect(f.err()).toBe('');
  });

  it('remembers never for that version, and asks again for the next one', async () => {
    const first = fake({ answer: 'never' });
    await withUpdateCheck(['validate', 'a'], run(), first.deps);
    expect(first.stored.value).toBe('0.2.0');
    expect(first.spawn).not.toHaveBeenCalled();

    const again = fake({ skip: '0.2.0' });
    await withUpdateCheck(['validate', 'a'], run(), again.deps);
    expect(again.ask).not.toHaveBeenCalled();

    const next = fake({ skip: '0.2.0', latest: '0.3.0' });
    await withUpdateCheck(['validate', 'a'], run(), next.deps);
    expect(next.ask).toHaveBeenCalled();
  });

  it('prints the command instead of asking when the manager is unknown', async () => {
    const f = fake({ install: { kind: 'unknown' } });
    await withUpdateCheck(['validate', 'a'], run(), f.deps);
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.err()).toBe(
      'demoflow 0.2.0 is available (you have 0.1.0). To update: npm install -g demoflow@0.2.0\n',
    );
  });

  it('prints a hint instead of asking for a project install', async () => {
    const f = fake({ install: { kind: 'local' } });
    await withUpdateCheck(['validate', 'a'], run(), f.deps);
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.err()).toContain('npm install demoflow@0.2.0');
  });

  it('keeps the exit code of the command when the install fails', async () => {
    const f = fake({ spawn: { code: 243 } });
    const code = await withUpdateCheck(['validate', 'a'], run(0), f.deps);
    expect(code).toBe(0);
    expect(f.err()).toContain('Update failed: npm exited with 243');
    expect(f.err()).toContain('EACCES');
    expect(f.err()).not.toContain('Updated to');
  });

  it('keeps the exit code of the command when the manager cannot start', async () => {
    const f = fake({
      install: { kind: 'global', manager: 'pnpm' },
      spawn: { error: 'spawn pnpm ENOENT' },
    });
    const code = await withUpdateCheck(['validate', 'a'], run(1), f.deps);
    expect(code).toBe(1);
    expect(f.err()).toContain('Update failed: spawn pnpm ENOENT');
    expect(f.err()).not.toContain('EACCES');
  });

  it('keeps the exit code when the check itself throws', async () => {
    const f = fake();
    f.deps.install = () => {
      throw new Error('boom');
    };
    expect(await withUpdateCheck(['validate', 'a'], run(5), f.deps)).toBe(5);
    f.deps.install = () => ({ kind: 'global', manager: 'npm' });
    f.deps.ask = async () => {
      throw new Error('boom');
    };
    expect(await withUpdateCheck(['validate', 'a'], run(6), f.deps)).toBe(6);
    expect(f.err()).toBe('');
  });

  it('asks after a failed command too', async () => {
    const f = fake({ answer: 'n' });
    expect(await withUpdateCheck(['validate', 'a'], run(2), f.deps)).toBe(2);
    expect(f.ask).toHaveBeenCalled();
  });
});
