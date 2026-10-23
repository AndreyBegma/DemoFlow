import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactMessage } from '../../src/runs-report/redact.ts';

const posix = {
  root: '/home/ann/shop',
  home: '/home/ann',
  pathApi: path.posix,
};
const windows = {
  root: 'C:\\Users\\Ann\\app',
  home: 'C:\\Users\\Ann',
  pathApi: path.win32,
};

describe('redactMessage', () => {
  it('drops the query string and fragment of a URL', () => {
    expect(redactMessage('https://host/p?token=x#y', posix)).toBe(
      'https://host/p',
    );
    expect(redactMessage('goto http://a.test/#/admin failed', posix)).toBe(
      'goto http://a.test/ failed',
    );
  });

  it('ends the URL at a quote, a parenthesis or an angle bracket', () => {
    expect(
      redactMessage('navigation to "https://h/p?s=1" timed out', posix),
    ).toBe('navigation to "https://h/p" timed out');
    expect(redactMessage("at 'http://h/?a=b' now", posix)).toBe(
      "at 'http://h/' now",
    );
    expect(redactMessage('page (https://h/x?q=1) closed', posix)).toBe(
      'page (https://h/x) closed',
    );
    expect(redactMessage('<https://h/x#frag>', posix)).toBe('<https://h/x>');
  });

  it('leaves a URL without a query alone', () => {
    expect(redactMessage('see https://h/docs/run.', posix)).toBe(
      'see https://h/docs/run.',
    );
  });

  it('replaces the root, then the home', () => {
    expect(
      redactMessage(
        'missing /home/ann/shop/demoflow/a.json; cache /home/ann/.cache/ms',
        posix,
      ),
    ).toBe('missing <project>/demoflow/a.json; cache ~/.cache/ms');
    expect(redactMessage('in /home/ann/shop', posix)).toBe('in <project>');
  });

  it('does not take a path for the prefix of a longer name', () => {
    expect(redactMessage('/home/anna/x and /home/ann/shop2', posix)).toBe(
      '/home/anna/x and ~/shop2',
    );
  });

  it('matches a POSIX path case-sensitively', () => {
    expect(redactMessage('/HOME/ANN/x', posix)).toBe('/HOME/ANN/x');
  });

  it('matches a Windows path with either separator and any case', () => {
    expect(redactMessage('at c:/users/ann/app/src/x.ts', windows)).toBe(
      'at <project>/src/x.ts',
    );
    expect(
      redactMessage(
        'C:\\Users\\Ann\\app\\a.png and C:/USERS/ANN/AppData',
        windows,
      ),
    ).toBe('<project>\\a.png and ~/AppData');
  });

  it('ignores a trailing separator on the root and home', () => {
    expect(
      redactMessage('/srv/app/x and /home/u/y', {
        root: '/srv/app/',
        home: '/home/u/',
        pathApi: path.posix,
      }),
    ).toBe('<project>/x and ~/y');
  });

  it('never replaces a filesystem root', () => {
    expect(
      redactMessage('/tmp/x', { root: '/', home: '/', pathApi: path.posix }),
    ).toBe('/tmp/x');
    expect(
      redactMessage('C:\\tmp', { root: 'C:\\', home: '', pathApi: path.win32 }),
    ).toBe('C:\\tmp');
  });

  it('keeps other absolute paths', () => {
    expect(redactMessage('wrote /tmp/demoflow-1/x', posix)).toBe(
      'wrote /tmp/demoflow-1/x',
    );
  });

  it('trims, and cuts a long message to 1000 characters ending in …', () => {
    expect(redactMessage('  boom \n', posix)).toBe('boom');
    expect(redactMessage(' \n\t ', posix)).toBe('');
    const cut = redactMessage('x'.repeat(5_000), posix);
    expect(cut).toHaveLength(1_000);
    expect(cut).toBe(`${'x'.repeat(999)}…`);
    expect(redactMessage('x'.repeat(1_000), posix)).toBe('x'.repeat(1_000));
  });

  it('never splits a surrogate pair when it cuts', () => {
    const whole = redactMessage(`${'x'.repeat(997)}😀${'y'.repeat(9)}`, posix);
    expect(whole).toBe(`${'x'.repeat(997)}😀…`);
    const split = redactMessage(`${'x'.repeat(998)}😀${'y'.repeat(9)}`, posix);
    expect(split).toBe(`${'x'.repeat(998)}…`);
  });
});
