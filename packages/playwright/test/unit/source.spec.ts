import { describe, expect, it } from 'vitest';
import { envNameOf } from '../../src/secrets.ts';
import { lineIn } from '../../src/source.ts';

describe('lineIn', () => {
  const stack = [
    'Error',
    '    at stackHere (/repo/src/recorder.ts:20:17)',
    '    at Proxy.<anonymous> (/repo/src/wrap.ts:140:9)',
    '    at search (/repo/tests/customers.spec.ts:6:43)',
    '    at /repo/tests/customers.spec.ts:13:11',
  ].join('\n');

  it('is the first frame in the test file', () => {
    expect(lineIn(stack, '/repo/tests/customers.spec.ts')).toBe(6);
  });

  it('is undefined when the test file is not on the stack', () => {
    expect(lineIn(stack, '/repo/tests/login.spec.ts')).toBe(undefined);
  });

  it('reads file URLs and CRLF stacks', () => {
    const url = 'Error\r\n    at file:///repo/tests/a.spec.ts:3:1\r\n';
    expect(lineIn(url, '/repo/tests/a.spec.ts')).toBe(3);
  });

  it('reads Windows paths', () => {
    const windows = 'Error\n    at fn (C:\\repo\\tests\\a.spec.ts:9:2)';
    expect(lineIn(windows, 'C:\\repo\\tests\\a.spec.ts')).toBe(9);
  });
});

describe('envNameOf', () => {
  const env = { B_SECRET: 'correct-horse', A_SECRET: 'correct-horse', SHORT: 'abc' };

  it('is the first variable in sorted order holding the value', () => {
    expect(envNameOf('correct-horse', env)).toBe('A_SECRET');
  });

  it('ignores values under 8 characters', () => {
    expect(envNameOf('abc', env)).toBe(undefined);
  });

  it('ignores names that are not environment variable names', () => {
    expect(envNameOf('correct-horse', { 'lower-case': 'correct-horse' })).toBe(
      undefined,
    );
  });
});
