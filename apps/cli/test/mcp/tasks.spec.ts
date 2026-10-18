import type { RunResult } from '@demoflow/core';
import { describe, expect, it } from 'vitest';
import type { ChildExit, RunChild } from '../../src/mcp/child.ts';
import { TaskQueue, type TaskSpec } from '../../src/mcp/tasks.ts';

interface FakeChild extends RunChild {
  args: string[];
  killed: boolean;
  /** Ends the child as `demoflow run` would, having written `result`. */
  exit(code: number, result?: RunResult['status']): void;
}

function harness() {
  const children: FakeChild[] = [];
  const results = new Map<string, RunResult['status']>();
  const removed: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const queue = new TaskQueue({
    spawn: (args) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      let resolve: (exit: ChildExit) => void = () => undefined;
      const exited = new Promise<ChildExit>((r) => {
        resolve = r;
      });
      let done = false;
      const end = (code: number | null) => {
        if (done) return;
        done = true;
        running -= 1;
        resolve({ code, stderrTail: code === null ? '' : 'boom\n' });
      };
      const child: FakeChild = {
        pid: 1000 + children.length,
        args,
        killed: false,
        exited,
        kill: async () => {
          child.killed = true;
          end(null);
          await exited;
        },
        exit: (code, status) => {
          if (status !== undefined) results.set(args[4] as string, status);
          end(code);
        },
      };
      children.push(child);
      return child;
    },
    readResult: async (runDir) => {
      const taskId = runDir.split('/').at(-1) as string;
      const status = results.get(taskId);
      if (status === undefined) throw new Error('ENOENT');
      return { status, renders: [], stages: {} } as unknown as RunResult;
    },
    removeFile: async (file) => {
      removed.push(file);
    },
  });
  const spec = (taskId: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
    taskId,
    root: '/proj',
    runDir: `/home/runs/${taskId}`,
    scenarioFile: '/proj/demoflow/a.demo.json',
    timeoutMs: 60_000,
    ...extra,
  });
  return {
    queue,
    children,
    removed,
    spec,
    maxRunning: () => maxRunning,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskQueue', () => {
  it('runs `demoflow run <file> --json --run-id <id> --project <root>`', () => {
    const { queue, children, spec } = harness();
    queue.submit(spec('t1'));
    expect(children[0]?.args).toEqual([
      'run',
      '/proj/demoflow/a.demo.json',
      '--json',
      '--run-id',
      't1',
      '--project',
      '/proj',
    ]);
  });

  it('is FIFO and never runs two tasks at once', async () => {
    const h = harness();
    const first = h.queue.submit(h.spec('t1'));
    const second = h.queue.submit(h.spec('t2'));
    const third = h.queue.submit(h.spec('t3'));
    expect([first.status, second.status, third.status]).toEqual([
      'running',
      'queued',
      'queued',
    ]);
    expect(h.queue.position('t1')).toBe(0);
    expect(h.queue.position('t2')).toBe(1);
    expect(h.queue.position('t3')).toBe(2);
    expect(h.children).toHaveLength(1);

    h.children[0]?.exit(0, 'completed');
    await tick();
    expect(first.status).toBe('completed');
    expect(second.status).toBe('running');
    expect(h.queue.position('t3')).toBe(1);

    h.children[1]?.exit(1, 'failed');
    await tick();
    h.children[2]?.exit(0, 'completed_with_warnings');
    await tick();
    expect([second.status, third.status]).toEqual(['failed', 'completed']);
    expect(h.maxRunning()).toBe(1);
  });

  it('a child that dies without result.json fails with its stderr', async () => {
    const h = harness();
    const task = h.queue.submit(h.spec('t1'));
    h.children[0]?.exit(3);
    await tick();
    expect(task.status).toBe('failed');
    expect(task.message).toContain('code 3');
    expect(task.message).toContain('boom');
  });

  it('cancelling a queued task means it never starts', async () => {
    const h = harness();
    h.queue.submit(h.spec('t1'));
    const queued = h.queue.submit(
      h.spec('t2', { staged: '/home/mcp/t2.demo.json' }),
    );
    await h.queue.cancel('t2');
    expect(queued.status).toBe('cancelled');
    expect(h.removed).toEqual(['/home/mcp/t2.demo.json']);
    h.children[0]?.exit(0, 'completed');
    await tick();
    expect(h.children).toHaveLength(1);
  });

  it('cancelling a running task kills its child and starts the next', async () => {
    const h = harness();
    const running = h.queue.submit(h.spec('t1'));
    h.queue.submit(h.spec('t2'));
    const task = await h.queue.cancel('t1');
    expect(task?.status).toBe('cancelled');
    expect(running.status).toBe('cancelled');
    expect(h.children[0]?.killed).toBe(true);
    expect(h.children).toHaveLength(2);
  });

  it('cancelling a finished task leaves it unchanged', async () => {
    const h = harness();
    const task = h.queue.submit(h.spec('t1'));
    h.children[0]?.exit(0, 'completed');
    await tick();
    await h.queue.cancel('t1');
    expect(task.status).toBe('completed');
  });

  it('a task past its timeout is killed and timed_out', async () => {
    const h = harness();
    const task = h.queue.submit(h.spec('t1', { timeoutMs: 20 }));
    await h.queue.wait('t1', 5_000);
    expect(task.status).toBe('timed_out');
    expect(h.children[0]?.killed).toBe(true);
  });

  it('wait returns when the task ends, or when the time is up', async () => {
    const h = harness();
    const task = h.queue.submit(h.spec('t1'));
    const started = performance.now();
    await h.queue.wait('t1', 30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(task.status).toBe('running');

    setTimeout(() => h.children[0]?.exit(0, 'completed'), 10);
    await h.queue.wait('t1', 5_000);
    expect(task.status).toBe('completed');
  });

  it('close kills the running child, cancels the queue, removes staged files', async () => {
    const h = harness();
    const running = h.queue.submit(
      h.spec('t1', { staged: '/home/mcp/t1.demo.json' }),
    );
    const queued = h.queue.submit(h.spec('t2'));
    await h.queue.close();
    expect(running.status).toBe('cancelled');
    expect(queued.status).toBe('cancelled');
    expect(h.children).toHaveLength(1);
    expect(h.children[0]?.killed).toBe(true);
    expect(h.removed).toContain('/home/mcp/t1.demo.json');
    expect(h.queue.submit(h.spec('t3')).status).toBe('cancelled');
  });
});
