/** Spec 247, Protocol: a scenario id is at most this long. */
export const SCENARIO_ID_MAX = 255;

const PREFIX = 'demoflow/';
const SUFFIX = '.demo.json';

/**
 * Spec 247's scenario id rule, applied again on receipt (spec 248, Decision 3):
 * the daemon never trusts the API's validation. A `/`-separated path relative
 * to the root, inside `demoflow/`, with no empty, `.` or `..` segment, and no
 * `\`, `:` or control character.
 */
export function isScenarioId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length < 1 || id.length > SCENARIO_ID_MAX) return false;
  if (!id.startsWith(PREFIX) || !id.endsWith(SUFFIX)) return false;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
    if (id[i] === '\\' || id[i] === ':') return false;
  }
  return id
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
