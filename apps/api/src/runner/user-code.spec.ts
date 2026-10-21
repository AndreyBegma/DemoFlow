import {
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from './user-code';

describe('user code', () => {
  it('generates 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      expect(code).not.toMatch(/[0O1IL]/);
      for (const char of code) {
        expect(USER_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it('formats with a dash and normalizes it back', () => {
    expect(formatUserCode('ABCD2345')).toBe('ABCD-2345');
    expect(normalizeUserCode('ABCD-2345')).toBe('ABCD2345');
    expect(normalizeUserCode(' abcd 2345 ')).toBe('ABCD2345');
  });

  it('refuses what cannot be a code', () => {
    expect(normalizeUserCode('ABCD-234')).toBeNull();
    expect(normalizeUserCode('ABCD-23456')).toBeNull();
    expect(normalizeUserCode('ABCD-2340')).toBeNull();
    expect(normalizeUserCode('ABCD-234L')).toBeNull();
    expect(normalizeUserCode('')).toBeNull();
  });
});
