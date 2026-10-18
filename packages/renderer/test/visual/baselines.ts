import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'baselines',
);

export function baselinePath(name: string): string {
  return path.join(BASELINES_DIR, `${name}.png`);
}

/** Where a failing comparison writes what it drew and how it differs, beside the baseline. */
export function failurePath(name: string, kind: 'actual' | 'diff'): string {
  return path.join(BASELINES_DIR, `${name}.${kind}.png`);
}
