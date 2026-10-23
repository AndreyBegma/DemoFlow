import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  formatPath,
  type Issue,
  RENDER_FORMATS,
  ScenarioSchema,
} from '@demoflow/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CommandError } from '../commands/errors.ts';
import { assertSafeRunId, generateRunId } from '../commands/run-id.ts';
import { readResult } from '../commands/settle.ts';
import {
  CliError,
  type HostEnvironment,
  loadGlobalConfig,
  osDataDir,
  runDir as runDirFor,
} from '../config/index.ts';
import { runnerPaths } from '../runner/paths.ts';
import {
  pageUrlFor,
  readReportedRunsByDir,
} from '../runs-report/reported-runs.ts';
import { packageVersion } from '../version.ts';
import { ToolError } from './errors.ts';
import {
  checkInlineScenario,
  resolveProject,
  resolveScenarioFile,
} from './project.ts';
import {
  checkProject,
  DEFAULT_LIST_LIMIT,
  listDemos,
  MAX_LIST_LIMIT,
  validateScenario,
} from './readonly.ts';
import { isTerminal, type TaskQueue, type TaskStatus } from './tasks.ts';
import { type TaskView, taskView } from './view.ts';

const DEFAULT_TIMEOUT_MINUTES = 15;
const MINUTE_MS = 60_000;
/** Headroom under the 60 s request timeout of MCP clients (the SDK's default). */
const MAX_WAIT_SECONDS = 50;

const GenerateDemoInput = z.strictObject({
  project: z
    .string()
    .optional()
    .describe(
      "Absolute path of the project (the directory with demoflow.config.json); default: the server's working directory.",
    ),
  scenario: ScenarioSchema.optional().describe(
    'An inline scenario. Exactly one of `scenario` and `file`.',
  ),
  file: z
    .string()
    .optional()
    .describe(
      'A *.demo.json file inside the project, relative to its root or absolute. Exactly one of `scenario` and `file`.',
    ),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe(
      `The task is killed and timed_out after this long; default ${DEFAULT_TIMEOUT_MINUTES}.`,
    ),
  formats: z
    .array(z.enum(RENDER_FORMATS))
    .min(1)
    .refine(
      (formats) => new Set(formats).size === formats.length,
      'expected each format once',
    )
    .optional()
    .describe(
      "The files to render, in order; replaces the project's render.formats (default there: mp4).",
    ),
});
/** The same input, with the scenario left for `parseScenario` and its issue paths. */
const GenerateDemoArgs = GenerateDemoInput.extend({
  scenario: z.unknown().optional(),
});

const GetTaskInput = z.strictObject({
  taskId: z.string().describe('The ID returned by generate_demo.'),
  waitSeconds: z
    .number()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Hold the reply until the task finishes or this many seconds pass (0–${MAX_WAIT_SECONDS}, default 0). Poll again to wait longer.`,
    ),
});

const CancelTaskInput = z.strictObject({
  taskId: z.string().describe('The ID returned by generate_demo.'),
});

const PROJECT_DESCRIPTION =
  "Absolute path of the project (the directory with demoflow.config.json); default: the server's working directory.";

const ValidateScenarioInput = z.strictObject({
  project: z.string().optional().describe(PROJECT_DESCRIPTION),
  scenario: ScenarioSchema.optional().describe(
    'An inline scenario. Exactly one of `scenario` and `file`.',
  ),
  file: z
    .string()
    .optional()
    .describe(
      'A *.demo.json file inside the project, relative to its root or absolute. Exactly one of `scenario` and `file`.',
    ),
});
/** The same input, with the scenario left for `parseScenario` and its issue paths. */
const ValidateScenarioArgs = ValidateScenarioInput.extend({
  scenario: z.unknown().optional(),
});

const ListDemosInput = z.strictObject({
  project: z.string().optional().describe(PROJECT_DESCRIPTION),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(
      `How many runs to return, newest first (1–${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT}).`,
    ),
});

const CheckProjectInput = z.strictObject({
  project: z.string().optional().describe(PROJECT_DESCRIPTION),
});

const TOOLS: Tool[] = [
  {
    name: 'generate_demo',
    description:
      'Queue a demo video run of a DemoFlow scenario in a local project. Returns a task ID at once; poll it with get_task. Runs execute one at a time. The first run on a machine may download the browser (~250 MB) and take longer.',
    inputSchema: inputSchema(GenerateDemoInput),
  },
  {
    name: 'get_task',
    description: `A task's status, stage results and artifact paths (video, timeline, source, run directory). Can wait up to ${MAX_WAIT_SECONDS} s for it to finish.`,
    inputSchema: inputSchema(GetTaskInput),
  },
  {
    name: 'cancel_task',
    description:
      'Cancel a task: a queued one never starts, a running one is killed; a finished one is unchanged.',
    inputSchema: inputSchema(CancelTaskInput),
  },
  {
    name: 'validate_scenario',
    description:
      'Check a scenario (inline or a *.demo.json in the project) against the scenario schema without running it. Returns { valid: true } or an invalid-scenario error with issue paths.',
    inputSchema: inputSchema(ValidateScenarioInput),
  },
  {
    name: 'list_demos',
    description:
      "Recent demo runs of the project's artifacts home, newest first: task ID, scenario name, status, start time, duration and video path.",
    inputSchema: inputSchema(ListDemosInput),
  },
  {
    name: 'check_project',
    description:
      'Whether a project is ready to run demos: its scenario files, a valid config, and FFmpeg and browser availability.',
    inputSchema: inputSchema(CheckProjectInput),
  },
];

export interface McpServerDeps {
  queue: TaskQueue;
  host: HostEnvironment;
  /** The default project, and where `DEMOFLOW_HOME` is resolved. */
  cwd: string;
  newTaskId?: () => string;
}

/** The `demoflow mcp` server, before it is connected to a transport. */
export function createMcpServer(deps: McpServerDeps): Server {
  const { queue, host, cwd } = deps;
  const newTaskId = deps.newTaskId ?? (() => generateRunId());
  /** Homes of the projects used by this server: where a finished task is found. */
  const homes = new Set<string>();

  const server = new Server(
    { name: 'demoflow', version: packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    try {
      switch (request.params.name) {
        case 'generate_demo':
          return ok(await generateDemo(parse(GenerateDemoArgs, args)));
        case 'get_task':
          return ok(await getTask(parse(GetTaskInput, args)));
        case 'cancel_task':
          return ok(await cancelTask(parse(CancelTaskInput, args)));
        case 'validate_scenario':
          return ok(
            validateScenario(parse(ValidateScenarioArgs, args), cwd, host),
          );
        case 'list_demos':
          return ok(await listDemos(parse(ListDemosInput, args), cwd, host));
        case 'check_project':
          return ok(
            await checkProject(parse(CheckProjectInput, args), cwd, host),
          );
        default:
          throw new ToolError(
            'invalid-input',
            `unknown tool: ${request.params.name}`,
            `Call one of: ${TOOLS.map((tool) => tool.name).join(', ')}.`,
          );
      }
    } catch (error) {
      if (error instanceof ToolError) return failure(error);
      throw error;
    }
  });

  async function generateDemo(
    input: z.infer<typeof GenerateDemoArgs>,
  ): Promise<{ taskId: string; status: TaskStatus; position: number }> {
    const inline = input.scenario !== undefined;
    if (inline === (input.file !== undefined)) {
      throw new ToolError(
        'both-or-neither-scenario',
        inline
          ? 'both `scenario` and `file` were given'
          : 'neither `scenario` nor `file` was given',
        'Pass exactly one: an inline `scenario` object, or the `file` of a *.demo.json in the project.',
      );
    }
    const project = resolveProject(input.project, cwd, host);
    let scenarioFile: string | undefined;
    if (input.file !== undefined) {
      scenarioFile = resolveScenarioFile(project.root, input.file);
    } else {
      checkInlineScenario(input.scenario);
    }

    let taskId = newTaskId();
    while (
      queue.get(taskId) !== undefined ||
      existsSync(runDirFor(project.home, taskId, host.platform))
    ) {
      taskId = newTaskId();
    }
    const runDir = runDirFor(project.home, taskId, host.platform);
    let staged: string | undefined;
    if (scenarioFile === undefined) {
      // Outside runs/: `run --run-id` refuses an existing run directory. The
      // engine copies the scenario into the run directory as scenario.json.
      staged = path.join(project.home, 'mcp', `${taskId}.demo.json`);
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, `${JSON.stringify(input.scenario, null, 2)}\n`);
      scenarioFile = staged;
    }

    homes.add(project.home);
    const task = queue.submit({
      taskId,
      root: project.root,
      runDir,
      scenarioFile,
      staged,
      timeoutMs: (input.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * MINUTE_MS,
      ...(input.formats === undefined ? {} : { formats: input.formats }),
    });
    return { taskId, status: task.status, position: queue.position(taskId) };
  }

  async function getTask(
    input: z.infer<typeof GetTaskInput>,
  ): Promise<TaskView> {
    checkTaskId(input.taskId);
    const task = queue.get(input.taskId);
    if (task === undefined) return fromDisk(input.taskId);
    const waitSeconds = Math.min(input.waitSeconds ?? 0, MAX_WAIT_SECONDS);
    await queue.wait(input.taskId, waitSeconds * 1000);
    return taskView({
      taskId: input.taskId,
      status: task.status,
      runDir: task.spec.runDir,
      pageUrl: isTerminal(task.status)
        ? await pageUrlOf(task.spec.runDir)
        : undefined,
      result: task.result,
      message: task.message,
      position:
        task.status === 'queued' ? queue.position(input.taskId) : undefined,
    });
  }

  /** Spec 225: read per call, never cached; a run reports in its last 2 s. */
  async function pageUrlOf(runDir: string): Promise<string | undefined> {
    return pageUrlFor(
      await readReportedRunsByDir(runnerPaths(host).reportedRuns),
      runDir,
    );
  }

  async function cancelTask(
    input: z.infer<typeof CancelTaskInput>,
  ): Promise<{ taskId: string; status: TaskStatus }> {
    checkTaskId(input.taskId);
    const task = await queue.cancel(input.taskId);
    if (task !== undefined)
      return { taskId: input.taskId, status: task.status };
    const { status } = await fromDisk(input.taskId);
    return { taskId: input.taskId, status };
  }

  /** A task of an earlier server: read back from `<home>/runs/<taskId>/result.json`. */
  async function fromDisk(taskId: string): Promise<TaskView> {
    for (const home of candidateHomes()) {
      const runDir = runDirFor(home, taskId, host.platform);
      if (!existsSync(runDir)) continue;
      try {
        const result = await readResult(runDir);
        const finished =
          result.status === 'completed' ||
          result.status === 'completed_with_warnings';
        return taskView({
          taskId,
          status: finished ? 'completed' : 'failed',
          runDir,
          result,
          pageUrl: await pageUrlOf(runDir),
          message:
            result.status === 'running'
              ? 'the run never finished: the server that ran it stopped'
              : undefined,
        });
      } catch {
        return taskView({
          taskId,
          status: 'failed',
          runDir,
          pageUrl: await pageUrlOf(runDir),
          message: 'the run directory has no readable result.json',
        });
      }
    }
    throw new ToolError(
      'task-not-found',
      `no task ${taskId}`,
      'Use a task ID returned by generate_demo. Unfinished tasks of a stopped server are gone; a finished one is found when its project is the server working directory or was used since the start.',
    );
  }

  /** Every home this server wrote to, then where an earlier one would have. */
  function candidateHomes(): Set<string> {
    const env = host.env.DEMOFLOW_HOME;
    const candidates = [
      ...homes,
      tryOrUndefined(() => resolveProject(undefined, cwd, host).home),
      env === undefined || env === '' ? undefined : path.resolve(cwd, env),
      tryOrUndefined(() => loadGlobalConfig(host).artifactsDir),
      osDataDir(host),
    ];
    return new Set(
      candidates.filter((home): home is string => home !== undefined),
    );
  }

  return server;
}

/** Task IDs become directory names: no separators, no `..`. */
function checkTaskId(taskId: string): void {
  try {
    assertSafeRunId(taskId);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    throw new ToolError(
      'task-not-found',
      `no task ${JSON.stringify(taskId)}`,
      'Use a task ID returned by generate_demo.',
    );
  }
}

function parse<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  const issues: Issue[] = parsed.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
  throw new ToolError(
    'invalid-input',
    'the tool arguments do not match its input schema',
    'Fix the arguments at the paths in `issues` and call again.',
    issues,
  );
}

function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
  });
  // A JSON Schema object: `properties` holds schemas, never bare booleans here.
  return { ...json, type: 'object' } as Tool['inputSchema'];
}

function ok(value: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: ToolError): CallToolResult {
  const payload = error.toPayload();
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
  };
}

function tryOrUndefined<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof ToolError || error instanceof CliError)
      return undefined;
    throw error;
  }
}
