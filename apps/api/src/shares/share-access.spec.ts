import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateToken } from '../auth/tokens';
import { SHARE_TOKEN } from './public-shares.service';
import {
  accessAllows,
  accessValue,
  resolveSigningSecret,
  SHARE_ACCESS_MS,
} from './share-access';

const SECRET = 'a'.repeat(32);
const SHARE = { id: 'cshare1', passwordHash: '$argon2id$v=19$one' };
const NOW = Date.parse('2026-10-20T12:00:00.000Z');

describe('resolveSigningSecret', () => {
  it('uses the secret when it is long enough', () => {
    expect(
      resolveSigningSecret({
        APP_ENV: 'production',
        SHARE_SIGNING_SECRET: SECRET,
      }),
    ).toBe(SECRET);
  });

  it('refuses a short secret', () => {
    expect(() =>
      resolveSigningSecret({ SHARE_SIGNING_SECRET: 'short' }),
    ).toThrow('SHARE_SIGNING_SECRET must be at least 32 characters');
  });

  it('refuses to start in production without one, naming the variable', () => {
    expect(() => resolveSigningSecret({ APP_ENV: 'production' })).toThrow(
      'SHARE_SIGNING_SECRET is not set',
    );
  });

  it('makes a random one per boot below production', () => {
    const first = resolveSigningSecret({ APP_ENV: 'development' });
    const second = resolveSigningSecret({ APP_ENV: 'development' });
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(first).not.toBe(second);
  });
});

describe('the unlock cookie', () => {
  const value = accessValue(SECRET, SHARE, NOW + SHARE_ACCESS_MS);

  it('is <exp>.<hmac> and opens its share until it expires', () => {
    expect(value).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(accessAllows(SECRET, SHARE, value, NOW)).toBe(true);
    expect(accessAllows(SECRET, SHARE, value, NOW + SHARE_ACCESS_MS)).toBe(
      false,
    );
  });

  it('does not open another share', () => {
    expect(accessAllows(SECRET, { ...SHARE, id: 'cshare2' }, value, NOW)).toBe(
      false,
    );
  });

  it('is void once the password changes', () => {
    expect(
      accessAllows(
        SECRET,
        { ...SHARE, passwordHash: '$argon2id$v=19$two' },
        value,
        NOW,
      ),
    ).toBe(false);
  });

  it('is void under another secret', () => {
    expect(accessAllows('b'.repeat(32), SHARE, value, NOW)).toBe(false);
  });

  it('refuses a later expiry with the old signature, and garbage', () => {
    const [, hmac] = value.split('.');
    const later = `${Math.floor(NOW / 1000) + 10 * 24 * 3600}.${hmac}`;
    expect(accessAllows(SECRET, SHARE, later, NOW)).toBe(false);
    expect(accessAllows(SECRET, SHARE, undefined, NOW)).toBe(false);
    expect(accessAllows(SECRET, SHARE, 'nope', NOW)).toBe(false);
  });
});

describe('the share token and the Caddy route', () => {
  const route = /path_regexp\s+(?:\S+\s+)?(\^\/s\/\S+\$)/;

  it.each([
    'staging',
    'production',
  ])('the %s Caddyfile routes /s/<token>/file and /poster for a real token', (env) => {
    const caddyfile = readFileSync(
      join(__dirname, '../../../../deploy', env, 'Caddyfile'),
      'utf8',
    );
    const pattern = route.exec(caddyfile)?.[1];
    expect(pattern).toBeDefined();
    const regexp = new RegExp(pattern ?? '$^');
    const token = generateToken();
    expect(token).toMatch(SHARE_TOKEN);
    expect(regexp.test(`/s/${token}/file`)).toBe(true);
    expect(regexp.test(`/s/${token}/poster`)).toBe(true);
    expect(regexp.test(`/s/${token}`)).toBe(false);
    expect(regexp.test(`/s/${token}/unlock`)).toBe(false);
  });
});
