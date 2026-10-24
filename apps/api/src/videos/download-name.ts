import type { RunFormat } from '../projects/projects.dto';

const BASE_MAX = 60;
const SCENARIO_FILE_SUFFIX = '.demo.json';

/** The fields of a run the name is made of; nothing that identifies a machine. */
export interface DownloadNameRun {
  scenarioName: string;
  scenarioPath: string;
  startedAt: Date;
}

/** ASCII `[a-z0-9-]` only, so the header needs no quoting or `filename*`. */
function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BASE_MAX)
    .replace(/-+$/, '');
}

function pathStem(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? '';
  return last.endsWith(SCENARIO_FILE_SUFFIX)
    ? last.slice(0, -SCENARIO_FILE_SUFFIX.length)
    : last;
}

/**
 * The file name a download is saved under (spec #299, Decision 4):
 * `<scenario>-<YYYY-MM-DD>[-vertical|-square].<ext>`.
 */
export function downloadName(run: DownloadNameRun, format: RunFormat): string {
  const base = slug(run.scenarioName) || slug(pathStem(run.scenarioPath));
  const date = run.startedAt.toISOString().slice(0, 10);
  const [extension, shape] = format.split('-');
  const suffix = shape === undefined ? '' : `-${shape}`;
  return `${base || 'demo'}-${date}${suffix}.${extension}`;
}
