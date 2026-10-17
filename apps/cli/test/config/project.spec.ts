import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliError,
  findProjectRoot,
  loadProjectConfig,
  scenarioId,
} from '../../src/config/index.ts';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-cli-')));
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

function codeOf(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('expected CliError');
}

describe('findProjectRoot', () => {
  it('finds the nearest ancestor holding demoflow.config.json', () => {
    write('demoflow.config.json', '{}');
    write('app/demoflow.config.json', '{}');
    const scenario = write('app/demoflow/a.demo.json', '{}');
    expect(findProjectRoot(scenario)).toBe(path.join(dir, 'app'));
  });

  it('walks up past directories without a config', () => {
    write('demoflow.config.json', '{}');
    const scenario = write('x/y/z/a.demo.json', '{}');
    expect(findProjectRoot(scenario)).toBe(dir);
  });

  it('accepts a config in the scenario file directory', () => {
    write('demoflow.config.json', '{}');
    expect(findProjectRoot(write('a.demo.json', '{}'))).toBe(dir);
  });

  it('exits 2 with no-project-config when there is none', () => {
    const error = codeOf(() =>
      findProjectRoot(path.join(dir, 'a.demo.json'), () => false),
    );
    expect(error.code).toBe('no-project-config');
    expect(error.exitCode).toBe(2);
  });
});

describe('scenarioId', () => {
  it('is the path relative to the root with / separators', () => {
    expect(
      scenarioId(
        '/proj',
        '/proj/apps/fixture/demoflow/a.demo.json',
        path.posix,
      ),
    ).toBe('apps/fixture/demoflow/a.demo.json');
  });

  it('turns Windows separators into /', () => {
    expect(
      scenarioId(
        'C:\\proj',
        'C:\\proj\\apps\\fixture\\demoflow\\a.demo.json',
        path.win32,
      ),
    ).toBe('apps/fixture/demoflow/a.demo.json');
  });

  it('resolves a relative scenario path against the root', () => {
    expect(scenarioId('C:\\proj', 'demoflow\\a.demo.json', path.win32)).toBe(
      'demoflow/a.demo.json',
    );
  });
});

describe('loadProjectConfig', () => {
  it('parses the config and applies defaults', () => {
    write('demoflow.config.json', '{"baseUrl": "http://localhost:3680"}');
    const config = loadProjectConfig(dir);
    expect(config.baseUrl).toBe('http://localhost:3680');
    expect(config.allowedOrigins).toEqual(['http://localhost:3680']);
    expect(config.render.width).toBe(1920);
  });

  it('loads the fixture config', () => {
    const fixture = path.resolve(import.meta.dirname, '../../../fixture');
    expect(loadProjectConfig(fixture).baseUrl).toBe('http://localhost:3680');
  });

  it('reports schema issues as invalid-config (exit 2)', () => {
    write('demoflow.config.json', '{"baseUrl": "not a url"}');
    const error = codeOf(() => loadProjectConfig(dir));
    expect(error.code).toBe('invalid-config');
    expect(error.exitCode).toBe(2);
    expect(error.issues.map((i) => i.path)).toContain('baseUrl');
  });

  it('reports unparsable JSON as invalid-config', () => {
    write('demoflow.config.json', '{nope');
    expect(codeOf(() => loadProjectConfig(dir)).code).toBe('invalid-config');
  });
});
