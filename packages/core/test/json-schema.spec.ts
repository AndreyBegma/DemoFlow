// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PORT}` is the config's own syntax, written as plain text on purpose.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jsonSchemas } from '../src/index.ts';

describe('committed JSON Schemas', () => {
  it('publishes the scenario and project config schemas', () => {
    expect(Object.keys(jsonSchemas()).sort()).toEqual([
      'project-config.schema.json',
      'scenario.schema.json',
    ]);
  });

  it.each(
    Object.entries(jsonSchemas()),
  )('schemas/%s matches the zod schema', (file, schema) => {
    const committed: unknown = JSON.parse(
      readFileSync(new URL(`../schemas/${file}`, import.meta.url), 'utf8'),
    );
    expect(
      committed,
      `schemas/${file} is stale — run: bun run --filter @demoflow/core schema`,
    ).toEqual(schema);
  });

  it('lets baseUrl and readyUrl hold ${PORT}: no uri format, the templates described', () => {
    const config = jsonSchemas()['project-config.schema.json'];
    const props = config.properties ?? {};
    const dev = props.devCommand;
    const devProps = typeof dev === 'object' ? (dev.properties ?? {}) : {};
    for (const field of [props.baseUrl, devProps.readyUrl]) {
      expect(field).toMatchObject({ pattern: '^[hH][tT][tT][pP][sS]?://' });
      expect(field).not.toHaveProperty('format');
    }
    for (const field of [
      props.baseUrl,
      devProps.command,
      devProps.args,
      devProps.readyUrl,
    ]) {
      const description =
        typeof field === 'object' ? (field.description ?? '') : '';
      expect(description).toContain('${PORT}');
      expect(description).toContain('${PORT:-3000}');
      expect(description).toContain('--port');
    }
    expect(devProps.readyUrl).toMatchObject({
      description: expect.stringContaining('${BASE_URL}'),
    });
  });

  it('describes the input: defaulted fields are optional', () => {
    const scenario = jsonSchemas()['scenario.schema.json'];
    expect(scenario.required).toEqual(['schemaVersion', 'name', 'steps']);
  });
});
