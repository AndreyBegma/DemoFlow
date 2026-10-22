import { describe, expect, it } from 'vitest';
import { isNewer, parseRelease } from '../../src/update/semver.ts';

describe('isNewer', () => {
  it('is true for a higher major, minor or patch', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
  });

  it('never offers a prerelease', () => {
    expect(isNewer('0.3.0-beta.1', '0.1.0')).toBe(false);
  });

  it('offers the release over a prerelease of the same version', () => {
    expect(isNewer('0.2.0', '0.2.0-beta.1')).toBe(true);
  });

  it('is false for anything that is not a version', () => {
    expect(isNewer('latest', '0.1.0')).toBe(false);
    expect(isNewer('0.2.0', 'dev')).toBe(false);
  });
});

describe('parseRelease', () => {
  it('accepts x.y.z only', () => {
    expect(parseRelease('1.2.3')).toBe('1.2.3');
    expect(parseRelease('1.2.3-rc.1')).toBeNull();
    expect(parseRelease('1.2.3 && rm -rf /')).toBeNull();
  });
});
