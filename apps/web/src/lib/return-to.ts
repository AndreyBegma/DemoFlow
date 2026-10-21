// Where a guest returns to after signing in (spec #135, Decision 6). The value
// comes from a query string, so only a path inside `/app` is accepted: an
// open redirect through `?next=` would turn the sign-in page into a phishing
// relay.

const APP_PATH = /^\/app(?:[/?#]|$)/;
// Control characters, backslashes (browsers read `\` as `/`), `//` (a
// protocol-relative URL) and `..` (a path that climbs out of `/app`).
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const UNSAFE = /[\u0000-\u001f\u007f\\]|\/\/|\.\./;

/** The sign-in URL that returns to `target`, or plain `/sign-in`. */
export function signInUrl(target: string | undefined): string {
  const next = safeReturnTo(target);
  return next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in';
}

/** `value` when it is a safe in-app path, otherwise undefined. */
export function safeReturnTo(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!APP_PATH.test(value) || UNSAFE.test(value)) return undefined;
  return value;
}
