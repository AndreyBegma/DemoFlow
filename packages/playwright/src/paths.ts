import path from 'node:path';

// Where a recorded scenario goes (spec 208, Decision 6):
// <configDir>/demoflow/playwright/[<project>/]<file>/<title>.demo.json

const SLUG_MAX = 80;

/** Lowercase, runs outside `[a-z0-9]` become `-`, trimmed, at most 80 characters. */
export function slug(text: string): string {
  const slugged = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slugged === '' ? 'test' : slugged;
}

/** `\` and `file://` URLs as `/` paths, so the same file compares equal on every OS. */
export function toSlashes(file: string): string {
  let out = file;
  if (out.startsWith('file://')) {
    out = decodeURIComponent(out.slice('file://'.length));
    // file:///C:/x → /C:/x → C:/x
    if (/^\/[A-Za-z]:/.test(out)) out = out.slice(1);
  }
  return out.replaceAll('\\', '/');
}

export interface ScenarioPathInput {
  /** The Playwright config's directory. */
  configDir: string;
  /** The project's `testDir`. */
  testDir: string;
  /** The test file, absolute. */
  file: string;
  /** `testInfo.titlePath` after the file: describe blocks and the title. */
  titles: readonly string[];
  /** The project's name, when the config has more than one project. */
  project?: string;
}

/** The absolute path of a test's recorded scenario. */
export function scenarioPath(input: ScenarioPathInput): string {
  const relative = path.relative(input.testDir, input.file);
  const segments = relative.split(/[\\/]/).filter((s) => s !== '');
  const last = segments.pop() ?? 'test';
  const extension = path.extname(last);
  const fileSegments = [
    ...segments.map(slug),
    slug(extension === '' ? last : last.slice(0, -extension.length)),
  ];
  return path.join(
    input.configDir,
    'demoflow',
    'playwright',
    ...(input.project === undefined ? [] : [slug(input.project)]),
    ...fileSegments,
    `${slug(input.titles.join('-'))}.demo.json`,
  );
}

/**
 * The scenarios one worker has written, so two tests never write the same
 * file: the second fails instead of overwriting the first.
 */
export class WrittenPaths {
  readonly #byPath = new Map<string, string>();

  /** Claims `file` for `title`; throws when another test holds it. */
  claim(file: string, title: string, shown: string): void {
    const holder = this.#byPath.get(file);
    if (holder !== undefined && holder !== title) {
      throw new Error(
        `demoflow: ${shown} is already written by ${JSON.stringify(holder)}`,
      );
    }
    this.#byPath.set(file, title);
  }
}
