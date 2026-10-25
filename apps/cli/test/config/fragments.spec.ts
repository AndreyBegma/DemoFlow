import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FragmentInput, ScenarioInput } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError } from '../../src/commands/errors.ts';
import { loadScenario } from '../../src/commands/scenario-file.ts';
import {
  lazyFragments,
  PROJECT_CONFIG_FILE,
  projectFragments,
} from '../../src/config/index.ts';
import { ToolError } from '../../src/mcp/errors.ts';
import {
  checkInlineScenario,
  resolveScenarioFile,
} from '../../src/mcp/project.ts';
import { validateScenario } from '../../src/mcp/readonly.ts';
import { checkScenario, nodeLaunchFs } from '../../src/runner/launch/checks.ts';

const signIn: FragmentInput = {
  schemaVersion: 1,
  params: { next: { default: '/' } },
  steps: [
    { action: 'navigate', path: '/login' },
    {
      action: 'fill',
      target: { label: 'Password' },
      valueFrom: { env: 'DEMO_LOGIN_PASSWORD' },
    },
    { action: 'navigate', path: '{{params.next}}' },
  ],
};

function scenario(steps: ScenarioInput['steps']): ScenarioInput {
  return { schemaVersion: 1, name: 'Fragments', steps };
}

const including = scenario([
  {
    action: 'include',
    fragment: 'sign-in',
    with: { next: '/projects' },
    record: false,
  },
  { action: 'marker', title: 'Projects' },
]);

/** Can this machine make a file symlink? Windows needs a privilege for it. */
function canLinkFiles(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'demoflow-link-'));
  try {
    writeFileSync(path.join(dir, 'a'), '');
    symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const FILE_LINKS = canLinkFiles();

let root: string;
let outside: string;

function write(file: string, value: unknown): string {
  const absolute = path.join(root, ...file.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  return absolute;
}

function config(extra: Record<string, unknown> = {}): void {
  write(PROJECT_CONFIG_FILE, { baseUrl: 'http://localhost:3000', ...extra });
}

function commandError(fn: () => unknown): CommandError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

function toolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

beforeEach(() => {
  // Real paths: the launch checks compare them.
  root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-fragments-')),
  );
  outside = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'demoflow-outside-')),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('projectFragments', () => {
  it('reads <fragmentsDir>/<name>.json, named relative to the root', () => {
    write('demoflow/fragments/auth/sign-in.json', signIn);
    expect(projectFragments(root)('auth/sign-in')).toEqual({
      ok: true,
      file: 'demoflow/fragments/auth/sign-in.json',
      value: signIn,
    });
  });

  it('reads from the configured directory', () => {
    write('shared/sign-in.json', signIn);
    expect(projectFragments(root, 'shared')('sign-in')).toMatchObject({
      ok: true,
      file: 'shared/sign-in.json',
    });
  });

  it('reports a missing file as missing', () => {
    expect(projectFragments(root)('sign-in')).toEqual({
      ok: false,
      file: 'demoflow/fragments/sign-in.json',
      missing: true,
      message: 'no such file',
    });
  });

  it('reports a file that is not JSON', () => {
    write('demoflow/fragments/sign-in.json', '{ nope');
    expect(projectFragments(root)('sign-in')).toMatchObject({
      ok: false,
      missing: false,
    });
  });

  it('refuses a fragments directory outside the project', () => {
    writeFileSync(path.join(outside, 'sign-in.json'), JSON.stringify(signIn));
    const relative = path.relative(root, outside);
    expect(projectFragments(root, relative)('sign-in')).toMatchObject({
      ok: false,
      missing: false,
      message: 'it is outside the project',
    });
  });

  it.skipIf(!FILE_LINKS)(
    'refuses a link that leads out of the project (skipped on Windows without the symlink privilege)',
    () => {
      writeFileSync(path.join(outside, 'sign-in.json'), JSON.stringify(signIn));
      mkdirSync(path.join(root, 'demoflow', 'fragments'), { recursive: true });
      symlinkSync(
        path.join(outside, 'sign-in.json'),
        path.join(root, 'demoflow', 'fragments', 'sign-in.json'),
      );
      expect(projectFragments(root)('sign-in')).toMatchObject({
        ok: false,
        message: 'it is outside the project',
      });
    },
  );
});

describe('lazyFragments', () => {
  it('makes the source only when a fragment is asked for', () => {
    let made = 0;
    const source = lazyFragments(() => {
      made++;
      return projectFragments(root);
    });
    expect(made).toBe(0);
    source('a');
    source('b');
    expect(made).toBe(1);
  });

  it('reports a source that cannot be made at the fragment', () => {
    const source = lazyFragments(() => {
      throw new Error('no demoflow.config.json');
    });
    expect(source('sign-in')).toEqual({
      ok: false,
      file: 'sign-in',
      missing: false,
      message: "cannot find the project's fragments: no demoflow.config.json",
    });
  });
});

describe('loadScenario with includes', () => {
  it('resolves includes from the project holding the file', () => {
    config();
    write('demoflow/fragments/sign-in.json', signIn);
    const file = write('demoflow/a.demo.json', including);
    const { scenario: loaded } = loadScenario(file);
    expect(loaded.steps.map((step) => step.action)).toEqual([
      'navigate',
      'fill',
      'navigate',
      'marker',
    ]);
    expect(loaded.steps[2]).toMatchObject({ path: '/projects', record: false });
  });

  it("follows the config's fragmentsDir", () => {
    config({ fragmentsDir: 'shared/fragments' });
    write('shared/fragments/sign-in.json', signIn);
    const file = write('demoflow/a.demo.json', including);
    expect(loadScenario(file).scenario.steps).toHaveLength(4);
  });

  it('names the missing fragment file and the include step', () => {
    config();
    const file = write('demoflow/a.demo.json', including);
    const error = commandError(() => loadScenario(file));
    expect(error.code).toBe('invalid-scenario');
    expect(error.issues).toEqual([
      expect.objectContaining({
        path: 'steps[0].fragment',
        message: expect.stringContaining('demoflow/fragments/sign-in.json'),
      }),
    ]);
  });

  it('needs no project for a scenario without includes', () => {
    const file = write('a.demo.json', scenario([{ action: 'wait', ms: 10 }]));
    expect(loadScenario(file).scenario.steps).toHaveLength(1);
  });

  it('reports an include outside any project at the include', () => {
    const file = write('a.demo.json', including);
    const error = commandError(() => loadScenario(file));
    expect(error.issues?.[0]).toMatchObject({ path: 'steps[0].fragment' });
  });
});

describe('the MCP checks with includes', () => {
  it('resolves a scenario file against the configured directory', () => {
    config({ fragmentsDir: 'shared' });
    write('shared/sign-in.json', signIn);
    const file = write('demoflow/a.demo.json', including);
    expect(resolveScenarioFile(root, 'demoflow/a.demo.json', 'shared')).toBe(
      file,
    );
    expect(
      toolError(() => resolveScenarioFile(root, 'demoflow/a.demo.json')).code,
    ).toBe('invalid-scenario');
  });

  it('checks an inline scenario against the project fragments', () => {
    write('demoflow/fragments/sign-in.json', signIn);
    expect(() =>
      checkInlineScenario(including, projectFragments(root)),
    ).not.toThrow();
    expect(toolError(() => checkInlineScenario(including)).code).toBe(
      'invalid-scenario',
    );
  });

  it('validates an inline include in the given project', () => {
    config();
    write('demoflow/fragments/sign-in.json', signIn);
    const host = {
      platform: process.platform,
      env: {},
      homedir: outside,
    } as const;
    expect(
      validateScenario({ project: root, scenario: including }, outside, host),
    ).toEqual({ valid: true });
  });
});

describe('the launch check with includes', () => {
  it('reads the fragments a scenario includes', async () => {
    write('demoflow/fragments/sign-in.json', signIn);
    write('demoflow/a.demo.json', including);
    await expect(
      checkScenario(root, 'demoflow/a.demo.json', nodeLaunchFs),
    ).resolves.toMatchObject({ ok: true, name: 'Fragments' });
  });

  it('is invalid when a fragment is missing', async () => {
    write('demoflow/a.demo.json', including);
    await expect(
      checkScenario(root, 'demoflow/a.demo.json', nodeLaunchFs),
    ).resolves.toEqual({ ok: false, code: 'scenario-invalid' });
  });

  it('follows the fragments directory it is given', async () => {
    write('shared/sign-in.json', signIn);
    write('demoflow/a.demo.json', including);
    await expect(
      checkScenario(root, 'demoflow/a.demo.json', nodeLaunchFs, 'shared'),
    ).resolves.toMatchObject({ ok: true });
  });

  it.skipIf(!FILE_LINKS)(
    'never follows a linked fragment (skipped on Windows without the symlink privilege)',
    async () => {
      write('shared/sign-in.json', signIn);
      write('demoflow/a.demo.json', including);
      mkdirSync(path.join(root, 'demoflow', 'fragments'));
      symlinkSync(
        path.join(root, 'shared', 'sign-in.json'),
        path.join(root, 'demoflow', 'fragments', 'sign-in.json'),
      );
      await expect(
        checkScenario(root, 'demoflow/a.demo.json', nodeLaunchFs),
      ).resolves.toEqual({ ok: false, code: 'scenario-invalid' });
    },
  );
});
