import type path from 'node:path';

/** The API's bound on `failure.message` (spec 263). */
export const MAX_MESSAGE_LENGTH = 1_000;

/**
 * The query string and fragment of an `http(s)://` URL: from the first `?` or
 * `#` to the end of the URL (whitespace, a quote, `)` or `>`).
 */
const URL_TAIL = /(https?:\/\/[^\s"'`)>?#]*)[?#][^\s"'`)>]*/gi;

/**
 * Spec 264, Decision 4: clean a failed stage's message on the machine, so
 * nothing ADR-0008 §2 forbids leaves it. Query strings and fragments of URLs
 * go, the project root becomes `<project>` and the home directory `~`; the
 * result is trimmed and cut to the API's 1000 characters.
 */
export function redactMessage(
  message: string,
  options: { root: string; home: string; pathApi: path.PlatformPath },
): string {
  const { root, home, pathApi } = options;
  let text = message.replace(URL_TAIL, '$1');
  // The root first: it usually sits under the home.
  text = replacePath(text, root, '<project>', pathApi);
  text = replacePath(text, home, '~', pathApi);
  return truncate(text.trim());
}

function replacePath(
  text: string,
  target: string,
  replacement: string,
  pathApi: path.PlatformPath,
): string {
  // A filesystem root (`/`, `C:\`) would turn every separator into `~`.
  if (target === '' || pathApi.dirname(target) === target) return text;
  const windows = pathApi.sep === '\\';
  const trimmed = target.replace(windows ? /[\\/]+$/ : /\/+$/, '');
  const source = trimmed
    .split(windows ? /[\\/]/ : '/')
    .map(escapeRegExp)
    .join(windows ? '[\\\\/]' : '/');
  // `/home/ann` is not a prefix of `/home/anna`.
  const pattern = new RegExp(
    `${source}(?![\\p{L}\\p{N}_-])`,
    windows ? 'giu' : 'gu',
  );
  return text.replace(pattern, replacement);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  let end = MAX_MESSAGE_LENGTH - 1;
  // Never split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
