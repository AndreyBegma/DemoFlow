import { z } from 'zod';
import { ProjectConfigSchema } from './project-config.ts';
import { ScenarioSchema } from './scenario.ts';

/**
 * The JSON Schemas published in `schemas/`, keyed by file name. They describe
 * the input an author writes, so fields with a default are optional.
 */
export function jsonSchemas(): Record<string, z.core.JSONSchema.BaseSchema> {
  const options = { io: 'input', target: 'draft-2020-12' } as const;
  return {
    'scenario.schema.json': z.toJSONSchema(ScenarioSchema, options),
    'project-config.schema.json': withoutUriFormat(
      z.toJSONSchema(ProjectConfigSchema, options),
    ),
  };
}

/**
 * `baseUrl` and `devCommand.readyUrl` may hold `${PORT}` (spec 337), and `{`
 * is not a URI character: editors would flag a valid template. The zod
 * schema still checks the substituted value is a URL.
 */
function withoutUriFormat(
  schema: z.core.JSONSchema.BaseSchema,
): z.core.JSONSchema.BaseSchema {
  const properties = schema.properties ?? {};
  const devCommand = properties.devCommand;
  const dev =
    typeof devCommand === 'object' ? (devCommand.properties ?? {}) : {};
  for (const field of [properties.baseUrl, dev.readyUrl]) {
    if (typeof field === 'object') delete field.format;
  }
  return schema;
}
