// Writes the JSON Schemas to `schemas/`: `bun run --filter @demoflow/core schema`.
// The files are committed; test/json-schema.spec.ts fails when they are stale.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { jsonSchemas } from '../src/json-schema.ts';

const dir = fileURLToPath(new URL('../schemas/', import.meta.url));
mkdirSync(dir, { recursive: true });

const files = Object.entries(jsonSchemas()).map(([name, schema]) => {
  const file = `${dir}${name}`;
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  return file;
});

// Leave the files as Biome formats them, so `bun run check` stays green.
const biome = createRequire(import.meta.url).resolve(
  '@biomejs/biome/bin/biome',
);
execFileSync(process.execPath, [biome, 'format', '--write', ...files], {
  stdio: 'inherit',
});
