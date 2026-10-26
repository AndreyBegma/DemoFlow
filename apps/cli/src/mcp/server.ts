import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
import { ServerError } from '../auth/client.ts';
import { readCredentials } from '../auth/credentials.ts';
import { CommandError } from '../commands/errors.ts';
import { assertSafeRunId, generateRunId } from '../commands/run-id.ts';
import { readResult } from '../commands/settle.ts';
import {
  CliError,
  type HostEnvironment,
  loadGlobalConfig,
  loadProjectConfig,
  osDataDir,
  projectFragments,
  runDir as runDirFor,
} from '../config/index.ts';
import { runnerPaths } from '../runner/paths.ts';
import {
  pageUrlFor,
  readReportedRunsByDir,
} from '../runs-report/reported-runs.ts';
import {
  createShare,
  DEFAULT_SHARE_LIFETIME,
  reportedRunOf,
  type ShareRefusalCode,
  ShareRefused,
  type ShareStatus,
  shareableFormat,
  type WaitDeps,
  waitForShare,
} from '../share/publish.ts';
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

/**
 * How to write a scenario beyond the schema (ADR-0018): an agent reuses the
 * project's fragments and keeps signing in off camera.
 */
const AUTHORING =
  'Reuse steps with { "action": "include", "fragment": "<name>", "with": { … } }: the fragment is <fragmentsDir>/<name>.json in the project (default demoflow/fragments), its steps use {{params.<name>}}. Steps the video must not show, such as signing in, go in `setup` or carry "record": false (also on an include): they run first, in the same browser context, before the recording starts, so the video opens already signed in. Only the opening steps can be off camera. Secrets come from valueFrom.env, never as values.';

const GenerateDemoInput = z.strictObject({
  project: z
    .string()
    .optional()
    .describe(
      "Absolute path of the project (the directory with demoflow.config.json); default: the server's working directory.",
    ),
  scenario: ScenarioSchema.optional().describe(
    `An inline scenario. Exactly one of \`scenario\` and \`file\`. ${AUTHORING}`,
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
    `An inline scenario. Exactly one of \`scenario\` and \`file\`. ${AUTHORING}`,
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

const ShareDemoInput = z.strictObject({
  runId: z
    .string()
    .describe('The task ID of a finished run (generate_demo, list_demos).'),
  format: z
    .enum(RENDER_FORMATS)
    .optional()
    .describe("The render to share; default: the run's first render."),
  expiresInDays: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .optional()
    .describe(
      `How long the link works, in days; default ${DEFAULT_SHARE_LIFETIME}.`,
    ),
});

/** What an agent can do about each refusal of the share API. */
const SHARE_HINTS: Record<ShareRefusalCode, string> = {
  'not-logged-in': 'Ask a person to run `demoflow login` on this machine.',
  'invalid-result': 'The run directory is damaged; generate the demo again.',
  'run-not-reported':
    'Only a run made while logged in, with reporting on, can be shared: generate the demo again after `demoflow login`.',
  'format-not-rendered':
    'Pass a format the run rendered (get_task lists the files), or generate the demo again with that format.',
  'artifacts-deleted':
    "The run's files were deleted on the website; generate the demo again.",
  'runner-offline':
    'Ask a person to start the runner: `demoflow runner start`.',
  'runner-outdated':
    'Ask a person to restart the runner: `demoflow runner stop`, then `demoflow runner start`.',
  'file-too-large': 'Share a smaller render, or make a shorter demo.',
  'quota-exceeded': 'Ask a person to revoke old shares on the website.',
};

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
      "Check a scenario (inline or a *.demo.json in the project) against the scenario schema without running it, its includes resolved from the project's fragments. Returns { valid: true } or an invalid-scenario error with issue paths; a problem inside a fragment names the fragment file and step.",
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
  {
    name: 'share_demo',
    description: `Publish a finished run's render as a link on the DemoFlow website: anyone with the link can watch it, until it expires. Refused with share-not-allowed unless the project's committed demoflow.config.json sets "share": { "allowMcp": true }. Needs a logged-in machine with its runner running. Waits up to ${MAX_WAIT_SECONDS} s for the upload; on status "uploading", call again with the same arguments to wait more — it returns the same share.`,
    inputSchema: inputSchema(ShareDemoInput),
  },
];

export interface McpServerDeps {
  queue: TaskQueue;
  host: HostEnvironment;
  /** The default project, and where `DEMOFLOW_HOME` is resolved. */
  cwd: string;
  newTaskId?: () => string;
  /** `share_demo`'s requests and clock; tests replace them. */
  share?: WaitDeps;
}

const processShareDeps: WaitDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => delay(ms),
  now: () => Date.now(),
};

/** The `demoflow mcp` server, before it is connected to a transport. */
export function createMcpServer(deps: McpServerDeps): Server {
  const { queue, host, cwd } = deps;
  const newTaskId = deps.newTaskId ?? (() => generateRunId());
  const shareDeps = deps.share ?? processShareDeps;
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
        case 'share_demo':
          return ok(await shareDemo(parse(ShareDemoInput, args)));
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
      scenarioFile = resolveScenarioFile(
        project.root,
        input.file,
        project.config.fragmentsDir,
      );
    } else {
      checkInlineScenario(
        input.scenario,
        projectFragments(project.root, project.config.fragmentsDir),
      );
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

  /**
   * Spec 349, Decision 7: what `demoflow share` does, without a password,
   * and only for a project whose committed config allows it.
   */
  async function shareDemo(input: z.infer<typeof ShareDemoInput>): Promise<{
    shareId: string;
    url: string;
    fileUrl: string | null;
    expiresAt: string;
    status: ShareStatus;
    existing: boolean;
  }> {
    checkTaskId(input.runId);
    const runDir = locateRunDir(input.runId);
    const indexFile = runnerPaths(host).reportedRuns;
    const entry = (await readReportedRunsByDir(indexFile)).get(
      path.resolve(runDir),
    );
    if (entry === undefined) {
      throw shareRefusal(
        new ShareRefused(
          'run-not-reported',
          'the run was never reported to the server: it was made signed out or with reporting off',
        ),
      );
    }
    checkShareAllowed(entry.root);
    try {
      const credentials = readCredentials(host);
      if (credentials === null) {
        throw new ShareRefused(
          'not-logged-in',
          'this machine is not logged in',
        );
      }
      await reportedRunOf(indexFile, runDir, credentials.server);
      const format = await shareableFormat(runDir, input.format);
      const created = await createShare(
        credentials,
        {
          runId: entry.id,
          format,
          expiresInDays: input.expiresInDays ?? DEFAULT_SHARE_LIFETIME,
        },
        shareDeps.fetch,
      );
      const share = await waitForShare(credentials, created.share, shareDeps, {
        timeoutMs: MAX_WAIT_SECONDS * 1000,
      });
      if (share.status === 'failed' || share.status === 'lost') {
        throw new ToolError(
          'share-failed',
          `the upload failed: ${share.failure ?? share.status}`,
          'Call share_demo again to retry: a failed share is replaced.',
        );
      }
      return {
        shareId: share.id,
        url: share.url,
        fileUrl: share.fileUrl,
        expiresAt: share.expiresAt,
        status: share.status,
        existing: created.existing,
      };
    } catch (error) {
      if (error instanceof ShareRefused) throw shareRefusal(error);
      if (error instanceof ServerError || error instanceof CliError) {
        throw new ToolError(
          'server-error',
          error.message,
          error instanceof ServerError && error.unreachable
            ? 'Check the network and the DemoFlow server, then call again.'
            : 'Ask a person to check `demoflow login` on this machine.',
        );
      }
      throw error;
    }
  }

  /** The run directory of a task of this server, or of an earlier one. */
  function locateRunDir(taskId: string): string {
    const task = queue.get(taskId);
    if (task !== undefined) return task.spec.runDir;
    for (const home of candidateHomes()) {
      const runDir = runDirFor(home, taskId, host.platform);
      if (existsSync(runDir)) return runDir;
    }
    throw new ToolError(
      'task-not-found',
      `no run ${taskId}`,
      'Use a task ID returned by generate_demo or list_demos.',
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

/**
 * ADR-0019 §6: an agent may publish a project's videos only when the
 * project's own, reviewed config says so. A run without a root, or a config
 * that cannot be read, is refused the same way.
 */
function checkShareAllowed(root: string | undefined): void {
  let allowed = false;
  if (root !== undefined) {
    try {
      allowed = loadProjectConfig(root).share?.allowMcp === true;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
    }
  }
  if (allowed) return;
  throw new ToolError(
    'share-not-allowed',
    root === undefined
      ? 'the run was reported without its project root, so no project allows sharing it'
      : `the project at ${root} does not let the MCP server share its demos`,
    'A person can share it with `demoflow share <runId>`. To let agents share this project\'s demos, a person sets "share": { "allowMcp": true } in its demoflow.config.json and commits it.',
  );
}

function shareRefusal(error: ShareRefused): ToolError {
  return new ToolError(error.code, error.message, SHARE_HINTS[error.code]);
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
