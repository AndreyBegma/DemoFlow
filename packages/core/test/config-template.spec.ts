// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
import { describe, expect, it } from 'vitest';
import {
  parseConfigTemplate,
  parsePort,
  parseProjectConfig,
  resolveConfigTemplates,
} from '../src/index.ts';

const templated = {
  baseUrl: 'http://127.0.0.1:${PORT}',
  devCommand: {
    command: 'node-${PORT}',
    args: ['server.mjs', '--port', '${PORT}', '--title=a b ${PORT}'],
    readyUrl: '${BASE_URL}/health',
  },
};

function errorsOf(input: unknown, variables = {}) {
  const result = parseProjectConfig(input, variables);
  if (result.ok) throw new Error('expected errors');
  return result.errors.map(({ path, code }) => ({ path, code }));
}

describe('parsePort', () => {
  it.each([
    ['1', 1],
    ['3000', 3000],
    ['65535', 65535],
  ])('accepts %s', (text, port) => {
    expect(parsePort(text)).toBe(port);
  });

  it.each([
    '0',
    '65536',
    '12a',
    '',
    ' 80',
    '-1',
    '1.5',
    '999999',
  ])('refuses %j', (text) => {
    expect(parsePort(text)).toBeUndefined();
  });
});

describe('parseConfigTemplate', () => {
  it('splits text and placeholders, with a default on PORT', () => {
    expect(parseConfigTemplate('a${PORT}b${PORT:-3000}${BASE_URL}')).toEqual({
      ok: true,
      template: [
        'a',
        { name: 'PORT' },
        'b',
        { name: 'PORT', default: 3000 },
        { name: 'BASE_URL' },
      ],
    });
  });

  it('keeps $${ as a literal ${ and a lone $ as is', () => {
    expect(parseConfigTemplate('$${PORT} costs $5')).toEqual({
      ok: true,
      template: ['${PORT} costs $5'],
    });
  });

  it.each([
    ['${HOME}', 'unknown-variable'],
    ['${port}', 'unknown-variable'],
    ['${PORT', 'unclosed-variable'],
    ['${BASE_URL:-x}', 'invalid-default'],
    ['${PORT:-x}', 'invalid-default'],
    ['${PORT:-0}', 'invalid-default'],
  ])('refuses %s with %s', (text, code) => {
    expect(parseConfigTemplate(text)).toMatchObject({ ok: false, code });
  });

  it('tells how to write ${HOME} literally', () => {
    const parsed = parseConfigTemplate('${HOME}');
    expect(parsed.ok || parsed.message).toBe(
      '${HOME} is not a DemoFlow variable; expected ${PORT} or ${BASE_URL}; write $${HOME} for a literal',
    );
  });
});

describe('templated project config', () => {
  it('substitutes ${PORT} in baseUrl, readyUrl, command and every argument', () => {
    const result = parseProjectConfig(templated, { port: 4123 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        baseUrl: 'http://127.0.0.1:4123',
        allowedOrigins: ['http://127.0.0.1:4123'],
        devCommand: {
          command: 'node-4123',
          args: ['server.mjs', '--port', '4123', '--title=a b 4123'],
          readyUrl: 'http://127.0.0.1:4123/health',
        },
      },
    });
  });

  it('fills ${BASE_URL} from a baseUrl override, and allowedOrigins follows it', () => {
    const result = parseProjectConfig(templated, {
      port: 4123,
      baseUrl: 'http://localhost:9000',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        baseUrl: 'http://127.0.0.1:4123',
        allowedOrigins: ['http://localhost:9000'],
        devCommand: { readyUrl: 'http://localhost:9000/health' },
      },
    });
  });

  it('takes --port over PORT, PORT over the default, the default last', () => {
    const config = { baseUrl: 'http://localhost:${PORT:-3000}' };
    const baseUrl = (variables: object) => {
      const result = parseProjectConfig(config, variables);
      return result.ok ? result.value.baseUrl : result.errors;
    };
    expect(baseUrl({ port: 1, envPort: '2' })).toBe('http://localhost:1');
    expect(baseUrl({ envPort: '2' })).toBe('http://localhost:2');
    expect(baseUrl({})).toBe('http://localhost:3000');
    expect(baseUrl({ standInPort: 9 })).toBe('http://localhost:3000');
  });

  it('reports the first port substituted, and whether ${PORT} is used', () => {
    expect(
      resolveConfigTemplates(templated, { envPort: '4500' }),
    ).toMatchObject({ ok: true, port: 4500, usesPort: true });
    expect(
      resolveConfigTemplates({ baseUrl: 'http://a.example' }, { port: 1 }),
    ).toEqual({
      ok: true,
      value: { baseUrl: 'http://a.example' },
      port: undefined,
      usesPort: false,
    });
  });

  it('needs a port when ${PORT} has no source: missing-port on each field', () => {
    expect(errorsOf(templated)).toEqual([
      { path: 'baseUrl', code: 'missing-port' },
      { path: 'devCommand.command', code: 'missing-port' },
      { path: 'devCommand.args[2]', code: 'missing-port' },
      { path: 'devCommand.args[3]', code: 'missing-port' },
    ]);
  });

  it('uses the stand-in port when nothing else gives one', () => {
    expect(parseProjectConfig(templated, { standInPort: 3000 })).toMatchObject({
      ok: true,
      value: { baseUrl: 'http://127.0.0.1:3000' },
    });
  });

  it('refuses an invalid PORT from the environment only when it is used', () => {
    expect(
      errorsOf({ baseUrl: 'http://a:${PORT}' }, { envPort: 'abc' }),
    ).toEqual([{ path: 'baseUrl', code: 'invalid-port' }]);
    expect(
      parseProjectConfig({ baseUrl: 'http://a.example' }, { envPort: 'abc' }),
    ).toMatchObject({ ok: true });
  });

  it('refuses ${BASE_URL} in baseUrl, and templates in allowedOrigins and artifactsDir', () => {
    expect(
      errorsOf(
        {
          baseUrl: '${BASE_URL}',
          allowedOrigins: ['http://a.example', 'http://b:${PORT}'],
          artifactsDir: 'out/${PORT}',
        },
        { port: 1 },
      ),
    ).toEqual([
      { path: 'baseUrl', code: 'variable-not-allowed' },
      { path: 'allowedOrigins[1]', code: 'variable-not-allowed' },
      { path: 'artifactsDir', code: 'variable-not-allowed' },
    ]);
  });

  it('reports syntax errors on the field path', () => {
    expect(
      errorsOf(
        {
          baseUrl: 'http://a:${PORT:-x}',
          devCommand: {
            command: '${HOME}',
            args: ['${PORT'],
            readyUrl: 'http://a.example',
          },
        },
        { port: 1 },
      ),
    ).toEqual([
      { path: 'baseUrl', code: 'invalid-default' },
      { path: 'devCommand.command', code: 'unknown-variable' },
      { path: 'devCommand.args[0]', code: 'unclosed-variable' },
    ]);
  });

  it('validates the substituted value: port 99999 is a URL issue', () => {
    expect(
      errorsOf({ baseUrl: 'http://localhost:${PORT:-3000}9' }, { port: 9999 }),
    ).toEqual([{ path: 'baseUrl', code: 'invalid_format' }]);
  });

  it('keeps $${ literal and leaves render text alone', () => {
    const result = parseProjectConfig(
      {
        baseUrl: 'http://a.example',
        devCommand: {
          command: 'sh',
          args: ['-c', 'echo $${HOME}'],
          readyUrl: 'http://a.example',
        },
        render: { cards: { outro: { title: 'Costs ${PORT}' } } },
      },
      {},
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        devCommand: { args: ['-c', 'echo ${HOME}'] },
        render: { cards: { outro: { title: 'Costs ${PORT}' } } },
      },
    });
  });

  it('parses a config without ${ exactly as before, with or without variables', () => {
    const config = {
      baseUrl: 'http://localhost:3000/app',
      devCommand: {
        command: 'npm',
        args: ['run', 'dev'],
        readyUrl: 'http://localhost:3000',
      },
      artifactsDir: 'out',
    };
    const before = parseProjectConfig(config);
    expect(parseProjectConfig(config, { port: 4000, envPort: 'abc' })).toEqual(
      before,
    );
    expect(parseProjectConfig(config, { standInPort: 3000 })).toEqual(before);
  });
});

describe('allowedOrigins follows the effective base URL', () => {
  it('omitted: the origin of baseUrl, or of the override', () => {
    expect(parseProjectConfig({ baseUrl: 'http://a.example/x' })).toMatchObject(
      { value: { allowedOrigins: ['http://a.example'] } },
    );
    expect(
      parseProjectConfig(
        { baseUrl: 'http://a.example/x' },
        { baseUrl: 'http://127.0.0.1:5000/y' },
      ),
    ).toMatchObject({ value: { allowedOrigins: ['http://127.0.0.1:5000'] } });
  });

  it('given: the effective origin is added once', () => {
    const config = {
      baseUrl: 'http://a.example',
      allowedOrigins: ['http://b.example'],
    };
    expect(parseProjectConfig(config)).toMatchObject({
      value: { allowedOrigins: ['http://b.example', 'http://a.example'] },
    });
    expect(
      parseProjectConfig(config, { baseUrl: 'http://b.example/z' }),
    ).toMatchObject({
      value: { allowedOrigins: ['http://b.example', 'http://a.example'] },
    });
    expect(
      parseProjectConfig(config, { baseUrl: 'http://c.example' }),
    ).toMatchObject({
      value: {
        allowedOrigins: [
          'http://b.example',
          'http://a.example',
          'http://c.example',
        ],
      },
    });
  });

  it('leaves an override that is not a URL to the run', () => {
    expect(
      parseProjectConfig({ baseUrl: 'http://a.example' }, { baseUrl: 'nope' }),
    ).toMatchObject({ value: { allowedOrigins: ['http://a.example'] } });
  });
});
