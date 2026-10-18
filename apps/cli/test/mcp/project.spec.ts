import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostEnvironment } from '../../src/config/index.ts';
import { ToolError } from '../../src/mcp/errors.ts';
import {
  checkInlineScenario,
  resolveProject,
  resolveScenarioFile,
} from '../../src/mcp/project.ts';

const CUSTOMERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixture/demoflow/customers.demo.json',
);

let dir: string;
let host: HostEnvironment;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-mcp-')));
  host = {
    platform: process.platform,
    env: {},
    homedir: path.join(dir, 'user'),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function toolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error('expected ToolError');
}

describe('resolveProject', () => {
  it('finds the root from the directory or a subdirectory', () => {
    write('app/demoflow.config.json', '{"baseUrl":"http://localhost:1"}');
    mkdirSync(path.join(dir, 'app/src'));
    const root = path.join(dir, 'app');
    expect(resolveProject(root, '/', host).root).toBe(root);
    expect(resolveProject(path.join(root, 'src'), '/', host).root).toBe(root);
    expect(resolveProject(undefined, root, host).root).toBe(root);
  });

  it('resolves the home as `demoflow run` does', () => {
    write(
      'app/demoflow.config.json',
      '{"baseUrl":"http://localhost:1","artifactsDir":".demoflow"}',
    );
    const root = path.join(dir, 'app');
    expect(resolveProject(root, '/', host).home).toBe(
      path.join(root, '.demoflow'),
    );
  });

  it.each([
    ['a relative path', 'app'],
    ['a missing directory', '/no/such/dir/anywhere'],
  ])('project-not-found for %s', (_, project) => {
    expect(toolError(() => resolveProject(project, dir, host)).code).toBe(
      'project-not-found',
    );
  });

  it('project-not-found when no config is above the directory', () => {
    const error = toolError(() => resolveProject(dir, dir, host));
    expect(error.code).toBe('project-not-found');
    expect(error.hint).not.toBe('');
  });

  it('invalid-project-config carries the config issues', () => {
    write('demoflow.config.json', '{"baseUrl":42}');
    const error = toolError(() => resolveProject(dir, dir, host));
    expect(error.code).toBe('invalid-project-config');
    expect(error.toPayload().issues?.[0]?.path).toBe('baseUrl');
  });
});

describe('resolveScenarioFile', () => {
  beforeEach(() => {
    write('demoflow.config.json', '{"baseUrl":"http://localhost:1"}');
    write('demoflow/a.demo.json', readFileSync(CUSTOMERS, 'utf8'));
  });

  it('accepts a path relative to the root, or absolute inside it', () => {
    const file = path.join(dir, 'demoflow/a.demo.json');
    expect(resolveScenarioFile(dir, 'demoflow/a.demo.json')).toBe(file);
    expect(resolveScenarioFile(dir, file)).toBe(file);
  });

  it.each([
    ['a ../ path', '../a.demo.json'],
    ['an absolute path outside', path.join(tmpdir(), 'x.demo.json')],
    ['a file that is not *.demo.json', 'demoflow.config.json'],
  ])('file-not-in-project for %s', (_, file) => {
    expect(toolError(() => resolveScenarioFile(dir, file)).code).toBe(
      'file-not-in-project',
    );
  });

  it('file-not-in-project for a symlink that leads out of the project', () => {
    const outside = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'demoflow-mcp-out-')),
    );
    try {
      const target = path.join(outside, 'b.demo.json');
      writeFileSync(target, readFileSync(CUSTOMERS, 'utf8'));
      try {
        symlinkSync(target, path.join(dir, 'demoflow/link.demo.json'));
      } catch {
        return; // Windows without the symlink privilege: nothing to test.
      }
      expect(
        toolError(() => resolveScenarioFile(dir, 'demoflow/link.demo.json'))
          .code,
      ).toBe('file-not-in-project');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('invalid-scenario lists the issue paths', () => {
    write(
      'demoflow/bad.demo.json',
      '{"schemaVersion":1,"name":"x","steps":[{"action":"click"}]}',
    );
    const error = toolError(() =>
      resolveScenarioFile(dir, 'demoflow/bad.demo.json'),
    );
    expect(error.code).toBe('invalid-scenario');
    expect(
      error.toPayload().issues?.some((i) => i.path.startsWith('steps[0]')),
    ).toBe(true);
  });

  it('scenario-unreadable for a missing file inside the project', () => {
    expect(
      toolError(() => resolveScenarioFile(dir, 'demoflow/none.demo.json')).code,
    ).toBe('scenario-unreadable');
  });
});

describe('checkInlineScenario', () => {
  it('accepts the fixture scenario', () => {
    expect(() =>
      checkInlineScenario(JSON.parse(readFileSync(CUSTOMERS, 'utf8'))),
    ).not.toThrow();
  });

  it('invalid-scenario with zod issue paths', () => {
    const scenario = JSON.parse(readFileSync(CUSTOMERS, 'utf8'));
    scenario.steps[0].action = 'teleport';
    const error = toolError(() => checkInlineScenario(scenario));
    expect(error.code).toBe('invalid-scenario');
    expect(error.toPayload().issues?.[0]?.path).toMatch(/^steps\[0\]/);
  });
});
