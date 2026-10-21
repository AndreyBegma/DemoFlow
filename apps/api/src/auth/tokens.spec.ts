import { generateToken, hashToken } from './tokens';

describe('tokens', () => {
  it('generates 256 random bits, base64url', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateToken()).not.toBe(token);
  });

  it('hashes with SHA-256, hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
