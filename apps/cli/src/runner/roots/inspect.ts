import { PROJECT_CONFIG_FILE } from '../../config/index.ts';
import { pathFor } from '../../config/platform.ts';
import type { LaunchFs, ProjectLoad } from '../launch/checks.ts';
import {
  LIST_MAX_FRAME_BYTES,
  type ListedScenario,
  listScenarios,
} from '../launch/list.ts';
import { githubUrlOf } from './git-remote.ts';

/**
 * Decision 5: everything an inspection says. Never a file's contents and
 * never a config value such as `baseUrl` or `devCommand`.
 */
export interface Inspection {
  rootPath: string;
  name: string;
  hasConfig: boolean;
  configValid: boolean;
  scenarios: ListedScenario[];
  githubUrl?: string;
}

export interface InspectDeps {
  fs: LaunchFs;
  platform: NodeJS.Platform;
  loadProject(root: string): ProjectLoad;
}

/**
 * Decision 5: inspects `root`, a folder that already passed the path rule.
 * Scenarios are listed only for a config that loads, by the same rules and
 * limits as `scenarios.list`. Throws only when listing them fails.
 */
export async function inspectFolder(
  root: string,
  roots: readonly string[],
  deps: InspectDeps,
): Promise<Inspection> {
  const p = pathFor(deps.platform);
  let hasConfig = false;
  try {
    // `lstat`: a linked config is not this folder's config.
    hasConfig = (
      await deps.fs.lstat(p.join(root, PROJECT_CONFIG_FILE))
    ).isFile();
  } catch {
    // No config.
  }
  const loaded = hasConfig ? deps.loadProject(root) : null;
  const configValid = loaded?.ok === true;
  const scenarios =
    loaded?.ok === true
      ? (await listScenarios(root, deps.fs, loaded.fragmentsDir)).scenarios
      : [];
  const githubUrl = await githubUrlOf(root, roots, deps.platform, deps.fs);
  return {
    rootPath: root,
    name: p.basename(root),
    hasConfig,
    configValid,
    scenarios,
    ...(githubUrl === undefined ? {} : { githubUrl }),
  };
}

/**
 * A reply frame with its inspection's scenarios dropped from the end until it
 * is at most 60,000 bytes, as `scenarios.listed` is cut.
 */
export function fitted(
  frame: (inspection: Inspection) => Record<string, unknown>,
  inspection: Inspection,
): Record<string, unknown> {
  const scenarios = [...inspection.scenarios];
  const build = () => frame({ ...inspection, scenarios });
  while (
    scenarios.length > 0 &&
    Buffer.byteLength(JSON.stringify(build()), 'utf8') > LIST_MAX_FRAME_BYTES
  ) {
    scenarios.pop();
  }
  return build();
}
