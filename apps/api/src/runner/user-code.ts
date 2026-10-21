import { randomInt } from 'node:crypto';

/** No 0 O 1 I L: a code read aloud or copied by hand survives (spec #135). */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const USER_CODE_LENGTH = 8;

/** A fresh code as stored: "ABCD1234". */
export function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** The code as people see it: "ABCD-1234". */
export function formatUserCode(code: string): string {
  const half = USER_CODE_LENGTH / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * A typed or linked code as stored, or null when it cannot be one. Accepts
 * lower case, the dash and spaces.
 */
export function normalizeUserCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== USER_CODE_LENGTH) {
    return null;
  }
  for (const char of code) {
    if (!USER_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return code;
}
