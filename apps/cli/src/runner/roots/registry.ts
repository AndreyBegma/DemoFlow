import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Decision 8: beyond this many entries the oldest are dropped. */
export const WEBSITE_PROJECTS_MAX = 1_000;

/** One line of `website-projects.jsonl`: a root registered from the website. */
export interface WebsiteProject {
  rootPath: string;
  registeredAt: string;
}

function parseLine(line: string): WebsiteProject | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const { rootPath, registeredAt } = value as Record<string, unknown>;
    if (typeof rootPath !== 'string' || rootPath === '') return null;
    if (typeof registeredAt !== 'string') return null;
    return { rootPath, registeredAt };
  } catch {
    return null;
  }
}

function parse(text: string): WebsiteProject[] {
  return text
    .split('\n')
    .map(parseLine)
    .filter((entry) => entry !== null);
}

/**
 * Decision 8: the roots registered from the website, read once. Never throws:
 * a missing or unreadable file registers nothing.
 */
export async function websiteRoots(file: string): Promise<Set<string>> {
  try {
    return new Set(parse(await readFile(file, 'utf8')).map((e) => e.rootPath));
  } catch {
    return new Set();
  }
}

/**
 * Decision 8: appends `rootPath` once. A root already there is left as it
 * is; past 1,000 entries the file is rewritten without the oldest.
 */
export function registerWebsiteProject(
  file: string,
  rootPath: string,
  registeredAt: string,
): void {
  let entries: WebsiteProject[] = [];
  try {
    entries = parse(readFileSync(file, 'utf8'));
  } catch {
    // A missing file starts empty.
  }
  if (entries.some((entry) => entry.rootPath === rootPath)) return;
  const entry: WebsiteProject = { rootPath, registeredAt };
  mkdirSync(path.dirname(file), { recursive: true });
  if (entries.length < WEBSITE_PROJECTS_MAX) {
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return;
  }
  const kept = [...entries.slice(-(WEBSITE_PROJECTS_MAX - 1)), entry];
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temp,
      kept.map((line) => `${JSON.stringify(line)}\n`).join(''),
      { mode: 0o600 },
    );
    if (process.platform !== 'win32') chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
