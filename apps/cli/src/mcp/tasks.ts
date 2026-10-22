import type { RenderFormat, RunResult } from '@demoflow/core';
import type { ChildExit, RunChild, SpawnRun } from './child.ts';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export function isTerminal(status: TaskStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

/** What a task runs; decided before it is queued. */
export interface TaskSpec {
  /** The task ID is the run ID: `<home>/runs/<taskId>/`. */
  taskId: string;
  root: string;
  runDir: string;
  /** The scenario file the child runs: in the project, or a staged inline one. */
  scenarioFile: string;
  /** A staged inline scenario, deleted once the task ends. */
  staged?: string;
  timeoutMs: number;
  /** Passed as `--format`, replacing the project's `render.formats`. */
  formats?: readonly RenderFormat[];
}

export interface Task {
  readonly spec: TaskSpec;
  status: TaskStatus;
  /** The run's `result.json`, once the child has written it. */
  result?: RunResult;
  /** Why a task failed when there is no `result.json` to say it. */
  message?: string;
}

export interface TaskQueueDeps {
  spawn: SpawnRun;
  readResult: (runDir: string) => Promise<RunResult>;
  removeFile: (file: string) => Promise<void>;
  /** One line per task start and end, for the server's stderr log. */
  log?: (line: string) => void;
}

interface Running {
  task: Task;
  child: RunChild;
  /** Set when the server ends the task: the child's exit is not the verdict. */
  ending?: 'cancelled' | 'timed_out';
  /** Resolves once the task has its terminal status. */
  settled: Promise<void>;
}

/**
 * Tasks of one server: FIFO, one child at a time (spec #68, Decisions 3, 4, 7).
 * Queued and running tasks live only here; finished ones are on disk too.
 */
export class TaskQueue {
  private readonly tasks = new Map<string, Task>();
  private readonly queue: Task[] = [];
  private readonly waiters = new Map<string, Set<() => void>>();
  private running: Running | undefined;
  private closed = false;
  private readonly deps: TaskQueueDeps;

  constructor(deps: TaskQueueDeps) {
    this.deps = deps;
  }

  submit(spec: TaskSpec): Task {
    const task: Task = { spec, status: 'queued' };
    this.tasks.set(spec.taskId, task);
    if (this.closed) {
      void this.end(task, 'cancelled');
      return task;
    }
    this.queue.push(task);
    this.pump();
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** Tasks ahead of this one: `0` while it runs or is next. */
  position(taskId: string): number {
    const index = this.queue.findIndex((task) => task.spec.taskId === taskId);
    if (index === -1) return 0;
    return index + (this.running === undefined ? 0 : 1);
  }

  /** Resolves when the task reaches a terminal status, or after `ms`. */
  async wait(taskId: string, ms: number): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task === undefined || isTerminal(task.status) || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(taskId) ?? new Set();
      this.waiters.set(taskId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  /**
   * A queued task is removed and never starts; a running one's child is
   * killed; a finished one is unchanged. Resolves with the task's status set.
   */
  async cancel(taskId: string): Promise<Task | undefined> {
    const task = this.tasks.get(taskId);
    if (task === undefined) return undefined;
    if (task.status === 'queued') {
      this.queue.splice(this.queue.indexOf(task), 1);
      await this.end(task, 'cancelled');
    } else if (this.running?.task === task) {
      await this.stop(this.running, 'cancelled');
    }
    return task;
  }

  /** Shutdown: nothing new starts, the queue is cancelled, the child is killed. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      this.queue.splice(0).map((task) => this.end(task, 'cancelled')),
    );
    if (this.running !== undefined) await this.stop(this.running, 'cancelled');
  }

  private pump(): void {
    if (this.closed || this.running !== undefined) return;
    const task = this.queue.shift();
    if (task === undefined) return;
    const { spec } = task;
    task.status = 'running';
    const child = this.deps.spawn(
      [
        'run',
        spec.scenarioFile,
        '--json',
        '--run-id',
        spec.taskId,
        '--project',
        spec.root,
        ...(spec.formats ?? []).flatMap((format) => ['--format', format]),
      ],
      spec.root,
    );
    this.deps.log?.(`task ${spec.taskId} started (pid ${child.pid ?? '?'})`);
    const timer = setTimeout(() => {
      void this.stop(running, 'timed_out');
    }, spec.timeoutMs);
    const running: Running = {
      task,
      child,
      settled: child.exited.then(async (exit) => {
        clearTimeout(timer);
        await this.finish(running, exit);
      }),
    };
    this.running = running;
  }

  private async stop(
    running: Running,
    reason: 'cancelled' | 'timed_out',
  ): Promise<void> {
    running.ending ??= reason;
    await running.child.kill();
    await running.settled;
  }

  private async finish(running: Running, exit: ChildExit): Promise<void> {
    const { task } = running;
    try {
      task.result = await this.deps.readResult(task.spec.runDir);
    } catch {
      // No result.json: the child died before the engine wrote it.
    }
    let status: TaskStatus;
    if (running.ending !== undefined) {
      status = running.ending;
    } else if (
      task.result?.status === 'completed' ||
      task.result?.status === 'completed_with_warnings'
    ) {
      status = 'completed';
    } else {
      status = 'failed';
      if (task.result === undefined) {
        task.message = failureMessage(exit);
      }
    }
    await this.end(task, status);
    this.running = undefined;
    this.pump();
  }

  /**
   * The terminal status is set only after the staged scenario is gone, so a
   * client that sees a finished task never finds its staging left behind
   * (spec #92). A failed removal is logged and does not change the status.
   */
  private async end(task: Task, status: TaskStatus): Promise<void> {
    const { staged } = task.spec;
    if (staged !== undefined) {
      try {
        await this.deps.removeFile(staged);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.log?.(
          `task ${task.spec.taskId} could not remove ${staged}: ${reason}`,
        );
      }
    }
    task.status = status;
    this.deps.log?.(`task ${task.spec.taskId} ${status}`);
    for (const waiter of this.waiters.get(task.spec.taskId) ?? []) waiter();
    this.waiters.delete(task.spec.taskId);
  }
}

function failureMessage(exit: ChildExit): string {
  const lines = exit.stderrTail.trim().split('\n').slice(-5).join('\n');
  return `demoflow run exited with code ${exit.code ?? 'null'}${lines === '' ? '' : `: ${lines}`}`;
}
