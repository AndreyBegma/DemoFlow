/**
 * A typed or linked device code as `ABCD-1234`, or undefined when it is not
 * 8 letters and digits (dash, spaces and case are free).
 */
export function normalizeUserCode(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) return undefined;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
