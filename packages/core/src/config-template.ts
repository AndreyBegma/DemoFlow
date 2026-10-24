// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
import { formatPath, type Issue } from './issues.ts';

/**
 * `${…}` templates in `demoflow.config.json` (spec 337): `${PORT}`,
 * `${PORT:-<n>}` and `${BASE_URL}`, filled once per run. `$${` is a literal
 * `${`; a lone `$` is literal.
 */
export type ConfigPlaceholder =
  | { name: 'PORT'; default?: number }
  | { name: 'BASE_URL' };

/** Literal text and placeholders, in order. */
export type ConfigTemplate = readonly (string | ConfigPlaceholder)[];

export type ConfigTemplateParse =
  | { ok: true; template: ConfigTemplate }
  | {
      ok: false;
      code: 'unknown-variable' | 'unclosed-variable' | 'invalid-default';
      message: string;
    };

/** The variables a run fills; core never reads the environment (ADR-0001). */
export interface ConfigVariables {
  /** `--port`, already validated: wins over everything else. */
  port?: number;
  /** `PORT` from the environment, as found: an issue only when a field uses `${PORT}`. */
  envPort?: string;
  /** `--base-url`: replaces the substituted `baseUrl` as `${BASE_URL}`. */
  baseUrl?: string;
  /** For commands that never start the app: a port used when no other is found. */
  standInPort?: number;
}

export type ConfigTemplateResult =
  | {
      ok: true;
      /** The input with every templated field substituted. */
      value: unknown;
      /** The first port substituted, if any field uses `${PORT}`. */
      port?: number;
      usesPort: boolean;
    }
  | { ok: false; errors: Issue[] };

const TOKEN = /\$\$\{|\$\{([^{}]*)\}|\$\{/g;
const BODY = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s;

/** The fields that take templates; `baseUrl` cannot use itself. */
const TEMPLATED_FIELDS =
  'baseUrl (${PORT}), devCommand.command, devCommand.args and devCommand.readyUrl';

/** A decimal integer from 1 to 65535, or undefined. */
export function parsePort(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

export function parseConfigTemplate(text: string): ConfigTemplateParse {
  const template: (string | ConfigPlaceholder)[] = [];
  let literal = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    literal += text.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === '$${') {
      literal += '${';
      continue;
    }
    const inner = match[1];
    if (inner === undefined) {
      return {
        ok: false,
        code: 'unclosed-variable',
        message: 'expected } to close ${ (write $${ for a literal ${)',
      };
    }
    const body = BODY.exec(inner);
    const name = body?.[1];
    if (body === null || (name !== 'PORT' && name !== 'BASE_URL')) {
      return {
        ok: false,
        code: 'unknown-variable',
        message: `${match[0]} is not a DemoFlow variable; expected \${PORT} or \${BASE_URL}; write $${match[0]} for a literal`,
      };
    }
    const fallback = body[2];
    let placeholder: ConfigPlaceholder;
    if (name === 'BASE_URL') {
      if (fallback !== undefined) {
        return {
          ok: false,
          code: 'invalid-default',
          message: '${BASE_URL} takes no default',
        };
      }
      placeholder = { name };
    } else if (fallback === undefined) {
      placeholder = { name };
    } else {
      const port = parsePort(fallback);
      if (port === undefined) {
        return {
          ok: false,
          code: 'invalid-default',
          message: `the default of ${match[0]} is not a port; expected an integer from 1 to 65535`,
        };
      }
      placeholder = { name, default: port };
    }
    if (literal !== '') template.push(literal);
    literal = '';
    template.push(placeholder);
  }
  literal += text.slice(last);
  if (literal !== '') template.push(literal);
  return { ok: true, template };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Substitutes the templated fields of a project config before its schema
 * runs (spec 337). `baseUrl` first; `${BASE_URL}` is then `variables.baseUrl`
 * or the substituted `baseUrl`, exactly as written. A port is `port`, else
 * `envPort`, else the field's own default, else `standInPort`. Values of the
 * wrong type are left for the schema to report.
 */
export function resolveConfigTemplates(
  input: unknown,
  variables: ConfigVariables = {},
): ConfigTemplateResult {
  if (!isRecord(input)) return { ok: true, value: input, usesPort: false };
  const errors: Issue[] = [];
  let port: number | undefined;
  let usesPort = false;

  const portFor = (
    path: readonly PropertyKey[],
    fallback: number | undefined,
  ): number | undefined => {
    if (variables.port !== undefined) return variables.port;
    if (variables.envPort !== undefined) {
      const fromEnv = parsePort(variables.envPort);
      if (fromEnv === undefined) {
        errors.push({
          path: formatPath(path),
          code: 'invalid-port',
          message: `PORT from the environment is ${JSON.stringify(variables.envPort)}; expected an integer from 1 to 65535`,
        });
      }
      return fromEnv;
    }
    if (fallback !== undefined) return fallback;
    if (variables.standInPort !== undefined) return variables.standInPort;
    errors.push({
      path: formatPath(path),
      code: 'missing-port',
      message:
        '${PORT} needs a port: pass --port <n>, set PORT, or write ${PORT:-3000}',
    });
    return undefined;
  };

  const substitute = (
    text: string,
    path: readonly PropertyKey[],
    baseUrl: string | undefined,
    allowBaseUrl: boolean,
  ): string => {
    const parsed = parseConfigTemplate(text);
    if (!parsed.ok) {
      errors.push({
        path: formatPath(path),
        code: parsed.code,
        message: parsed.message,
      });
      return text;
    }
    let out = '';
    for (const part of parsed.template) {
      if (typeof part === 'string') {
        out += part;
      } else if (part.name === 'PORT') {
        usesPort = true;
        const value = portFor(path, part.default);
        if (value === undefined) return text;
        port ??= value;
        out += String(value);
      } else if (!allowBaseUrl) {
        errors.push({
          path: formatPath(path),
          code: 'variable-not-allowed',
          message: `\${BASE_URL} cannot be used in baseUrl itself; use \${PORT}`,
        });
        return text;
      } else if (baseUrl === undefined) {
        // baseUrl is missing or invalid: its own issue says so.
        return text;
      } else {
        out += baseUrl;
      }
    }
    return out;
  };

  const notAllowed = (text: unknown, path: readonly PropertyKey[]): void => {
    if (typeof text !== 'string') return;
    const parsed = parseConfigTemplate(text);
    if (parsed.ok && parsed.template.every((part) => typeof part === 'string'))
      return;
    errors.push({
      path: formatPath(path),
      code: 'variable-not-allowed',
      message: `templates are allowed only in ${TEMPLATED_FIELDS}`,
    });
  };

  const value: Record<string, unknown> = { ...input };
  let baseUrl: string | undefined;
  if (typeof input.baseUrl === 'string') {
    const before = errors.length;
    const substituted = substitute(
      input.baseUrl,
      ['baseUrl'],
      undefined,
      false,
    );
    value.baseUrl = substituted;
    if (errors.length === before) baseUrl = substituted;
  }
  const effectiveBaseUrl = variables.baseUrl ?? baseUrl;

  const dev = input.devCommand;
  if (isRecord(dev)) {
    const devValue: Record<string, unknown> = { ...dev };
    for (const key of ['command', 'readyUrl'] as const) {
      const text = dev[key];
      if (typeof text === 'string') {
        devValue[key] = substitute(
          text,
          ['devCommand', key],
          effectiveBaseUrl,
          true,
        );
      }
    }
    if (Array.isArray(dev.args)) {
      devValue.args = dev.args.map((arg: unknown, index) =>
        typeof arg === 'string'
          ? substitute(
              arg,
              ['devCommand', 'args', index],
              effectiveBaseUrl,
              true,
            )
          : arg,
      );
    }
    value.devCommand = devValue;
  }

  if (Array.isArray(input.allowedOrigins)) {
    input.allowedOrigins.forEach((origin: unknown, index) => {
      notAllowed(origin, ['allowedOrigins', index]);
    });
  }
  notAllowed(input.artifactsDir, ['artifactsDir']);

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value, port, usesPort };
}
