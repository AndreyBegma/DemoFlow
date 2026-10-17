import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ADR-0001: core depends on zod and nothing else, and uses no Node APIs.
describe('package boundary', () => {
  it('lists zod as its only runtime dependency', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('imports nothing under src but zod and its own files', () => {
    const src = new URL('../src/', import.meta.url);
    const files = readdirSync(src, {
      recursive: true,
      encoding: 'utf8',
    }).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const specifiers = files.flatMap((file) => {
      const code = readFileSync(new URL(file, src), 'utf8');
      return [
        ...code.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
        ),
      ].map((match) => match[1]);
    });
    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.filter((s) => s !== 'zod' && !s.startsWith('./')),
    ).toEqual([]);
  });
});
