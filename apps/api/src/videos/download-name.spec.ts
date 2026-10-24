import type { RunFormat } from '../projects/projects.dto';
import { downloadName } from './download-name';

const RUN_FORMATS: RunFormat[] = [
  'mp4',
  'gif',
  'webm',
  'mp4-vertical',
  'gif-vertical',
  'webm-vertical',
];

const startedAt = new Date('2026-10-24T23:59:59.000Z');

function run(scenarioName: string, scenarioPath = 'demos/checkout.demo.json') {
  return { scenarioName, scenarioPath, startedAt };
}

describe('downloadName', () => {
  it('names a Latin scenario', () => {
    expect(downloadName(run('Sign in & checkout'), 'mp4-vertical')).toBe(
      'sign-in-checkout-2026-10-24-vertical.mp4',
    );
  });

  it('strips accents', () => {
    expect(downloadName(run('Café déjà vu'), 'mp4')).toBe(
      'cafe-deja-vu-2026-10-24.mp4',
    );
  });

  it('falls back to the path stem when the name has no Latin letters', () => {
    expect(downloadName(run('вход в систему'), 'webm')).toBe(
      'checkout-2026-10-24.webm',
    );
  });

  it('uses the last segment of a Windows path too', () => {
    expect(downloadName(run('!!!', 'demos\\Log In.demo.json'), 'gif')).toBe(
      'log-in-2026-10-24.gif',
    );
  });

  it('falls back to demo when both are empty', () => {
    expect(downloadName(run('日本語', '日本語.demo.json'), 'gif')).toBe(
      'demo-2026-10-24.gif',
    );
  });

  it('cuts a long name to 60 characters and trims a trailing dash', () => {
    const long = downloadName(run('a'.repeat(200)), 'mp4');
    expect(long).toBe(`${'a'.repeat(60)}-2026-10-24.mp4`);
    const dashed = downloadName(run(`${'a'.repeat(59)} bcd`), 'mp4');
    expect(dashed).toBe(`${'a'.repeat(59)}-2026-10-24.mp4`);
  });

  it.each([
    ['mp4', 'x-2026-10-24.mp4'],
    ['webm', 'x-2026-10-24.webm'],
    ['gif', 'x-2026-10-24.gif'],
    ['mp4-vertical', 'x-2026-10-24-vertical.mp4'],
    ['webm-vertical', 'x-2026-10-24-vertical.webm'],
    ['gif-vertical', 'x-2026-10-24-vertical.gif'],
  ] as const)('suffixes %s', (format, expected) => {
    expect(downloadName(run('x'), format)).toBe(expected);
  });

  it('only ever yields a header-safe name', () => {
    for (const format of RUN_FORMATS) {
      for (const name of ['"; rm\r\nX: y', '../../etc/passwd', '  ', 'a/b']) {
        expect(downloadName(run(name, name), format)).toMatch(
          /^[a-z0-9-]+-\d{4}-\d{2}-\d{2}(-vertical)?\.(mp4|webm|gif)$/,
        );
      }
    }
  });
});
