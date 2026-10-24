// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
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
  loadAppConfig,
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

describe('a config with ${PORT}', () => {
  const templated = JSON.stringify({
    baseUrl: 'http://127.0.0.1:${PORT}',
    devCommand: {
      command: 'node',
      args: ['server.mjs', '--port', '${PORT}'],
      readyUrl: '${BASE_URL}/',
    },
  });

  beforeEach(() => {
    write('demoflow.config.json', templated);
  });

  it('takes --port over PORT, PORT over the default', () => {
    write(
      'demoflow.config.json',
      '{"baseUrl": "http://127.0.0.1:${PORT:-3000}"}',
    );
    const baseUrl = (options: Parameters<typeof loadAppConfig>[1]) =>
      loadAppConfig(dir, options).config.baseUrl;
    expect(baseUrl({ port: 4001, env: { PORT: '4002' } })).toBe(
      'http://127.0.0.1:4001',
    );
    expect(baseUrl({ env: { PORT: '4002' } })).toBe('http://127.0.0.1:4002');
    expect(baseUrl({ env: {} })).toBe('http://127.0.0.1:3000');
    expect(loadAppConfig(dir, { env: {} }).port).toBe(3000);
  });

  it('fills every templated field and reports the port for the app', () => {
    const app = loadAppConfig(dir, { port: 4123, env: {} });
    expect(app).toMatchObject({ port: 4123, usesPort: true });
    expect(app.config.devCommand).toEqual({
      command: 'node',
      args: ['server.mjs', '--port', '4123'],
      readyUrl: 'http://127.0.0.1:4123/',
    });
  });

  it('strict mode: no port from any source is invalid-config with missing-port', () => {
    const error = codeOf(() => loadAppConfig(dir, { env: {} }));
    expect(error.code).toBe('invalid-config');
    expect(error.exitCode).toBe(2);
    expect(error.issues.map(({ path, code }) => [path, code])).toEqual([
      ['baseUrl', 'missing-port'],
      ['devCommand.args[2]', 'missing-port'],
    ]);
  });

  it('strict mode: an empty PORT counts as unset, an invalid one is invalid-port', () => {
    expect(
      codeOf(() => loadAppConfig(dir, { env: { PORT: '' } })).issues[0].code,
    ).toBe('missing-port');
    expect(
      codeOf(() => loadAppConfig(dir, { env: { PORT: 'abc' } })).issues[0]
        .code,
    ).toBe('invalid-port');
  });

  it('--port without ${PORT} in the config still reaches the app', () => {
    write('demoflow.config.json', '{"baseUrl": "http://localhost:3000"}');
    expect(loadAppConfig(dir, { port: 4123, env: {} })).toMatchObject({
      port: 4123,
      usesPort: false,
      config: { baseUrl: 'http://localhost:3000' },
    });
  });

  it('stand-in mode loads the same config without a port, or with an invalid PORT', () => {
    expect(loadProjectConfig(dir, {}).baseUrl).toBe('http://127.0.0.1:3000');
    expect(loadProjectConfig(dir, { PORT: 'abc' }).baseUrl).toBe(
      'http://127.0.0.1:3000',
    );
    expect(loadProjectConfig(dir, { PORT: '4500' }).baseUrl).toBe(
      'http://127.0.0.1:4500',
    );
  });

  it('stand-in mode still refuses a syntax error', () => {
    write('demoflow.config.json', '{"baseUrl": "http://a:${PORT:-x}"}');
    expect(codeOf(() => loadProjectConfig(dir, {})).issues[0].code).toBe(
      'invalid-default',
    );
  });
});
