import path from 'node:path';
import { checkScenario, type LaunchFs } from './checks.ts';

/** Decision 5 and spec 247, Protocol. */
export const LIST_MAX_SCENARIOS = 100;
export const LIST_MAX_FRAME_BYTES = 60_000;
export const LIST_MAX_DEPTH = 16;
export const LIST_MAX_ENTRIES = 10_000;
export const NAME_MAX = 200;

const SCENARIOS_DIR = 'demoflow';
const SUFFIX = '.demo.json';

export interface ListedScenario {
  id: string;
  name: string;
}

export interface Listing {
  scenarios: ListedScenario[];
  truncated: boolean;
  skipped: number;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/** At most 200 UTF-16 units, without splitting a surrogate pair. */
function cutName(name: string): string {
  if (name.length <= NAME_MAX) return name;
  const cut = name.slice(0, NAME_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Decision 5: every `*.demo.json` under `<root>/demoflow/` that passes the
 * scenario checks, sorted by id. The walk uses `lstat` only: a linked
 * directory is never entered and a linked file never read. Throws only on a
 * read error other than a missing `demoflow/`.
 */
export async function listScenarios(
  root: string,
  fs: LaunchFs,
): Promise<Listing> {
  const top = path.join(root, SCENARIOS_DIR);
  const empty: Listing = { scenarios: [], truncated: false, skipped: 0 };
  try {
    // A linked `demoflow/` is not entered either.
    if (!(await fs.lstat(top)).isDirectory()) return empty;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return empty;
    throw error;
  }
  const ids: string[] = [];
  let seen = 0;
  let truncated = false;
  const walk = async (dir: string, prefix: string, depth: number) => {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (++seen > LIST_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const id = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth >= LIST_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        await walk(path.join(dir, entry.name), id, depth + 1);
        if (seen > LIST_MAX_ENTRIES) return;
      } else if (entry.isFile() && entry.name.endsWith(SUFFIX)) {
        ids.push(id);
      }
    }
  };
  await walk(top, SCENARIOS_DIR, 1);
  const scenarios: ListedScenario[] = [];
  let skipped = 0;
  for (const id of ids) {
    const check = await checkScenario(root, id, fs);
    if (check.ok) scenarios.push({ id, name: cutName(check.name) });
    else skipped++;
  }
  scenarios.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (scenarios.length > LIST_MAX_SCENARIOS) {
    scenarios.length = LIST_MAX_SCENARIOS;
    truncated = true;
  }
  return { scenarios, truncated, skipped };
}

/**
 * The `scenarios.listed` frame, with entries dropped from the end until it is
 * at most 60,000 bytes: under the socket's 64 KiB limit with room to spare.
 */
export function listedFrame(
  requestId: string,
  listing: Listing,
): Record<string, unknown> {
  const scenarios = [...listing.scenarios];
  let truncated = listing.truncated;
  const frame = () => ({
    type: 'scenarios.listed',
    requestId,
    scenarios,
    truncated,
    skipped: listing.skipped,
  });
  while (
    scenarios.length > 0 &&
    Buffer.byteLength(JSON.stringify(frame()), 'utf8') > LIST_MAX_FRAME_BYTES
  ) {
    scenarios.pop();
    truncated = true;
  }
  return frame();
}
