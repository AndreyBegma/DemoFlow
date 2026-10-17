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
    'project-config.schema.json': z.toJSONSchema(ProjectConfigSchema, options),
  };
}
