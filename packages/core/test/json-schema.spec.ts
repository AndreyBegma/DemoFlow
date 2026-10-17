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

  it('describes the input: defaulted fields are optional', () => {
    const scenario = jsonSchemas()['scenario.schema.json'];
    expect(scenario.required).toEqual(['schemaVersion', 'name', 'steps']);
  });
});
