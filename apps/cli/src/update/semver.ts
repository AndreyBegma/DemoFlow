/** A version as `[major, minor, patch]`, with its prerelease tag if any. */
interface Parsed {
  core: [number, number, number];
  prerelease: boolean;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function parse(version: string): Parsed | null {
  const match = VERSION.exec(version);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** A release `x.y.z`: a prerelease, build metadata or anything else is null. */
export function parseRelease(version: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/**
 * Spec 166, Decision 3: `latest > current`, and `latest` is a release. A
 * prerelease `current` is older than the release of the same core.
 */
export function isNewer(latest: string, current: string): boolean {
  if (parseRelease(latest) === null) return false;
  const a = parse(latest);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return b.prerelease;
}
