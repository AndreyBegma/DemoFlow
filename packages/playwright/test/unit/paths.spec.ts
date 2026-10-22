import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scenarioPath,
  slug,
  toSlashes,
  WrittenPaths,
} from '../../src/paths.ts';

const root = path.resolve('/project');

describe('slug', () => {
  it('lowercases and turns runs of anything else into one -', () => {
    expect(slug('Auth › Signs in!')).toBe('auth-signs-in');
    expect(slug('--a__b--')).toBe('a-b');
  });

  it('is "test" when nothing is left', () => {
    expect(slug('—')).toBe('test');
  });

  it('cuts an 81-character title to 80', () => {
    const title = 'a'.repeat(81);
    expect(slug(title)).toBe('a'.repeat(80));
  });

  it('does not end on a - after the cut', () => {
    expect(slug(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
  });
});

describe('scenarioPath', () => {
  it('folds the extension into the file and joins the titles', () => {
    expect(
      scenarioPath({
        configDir: root,
        testDir: path.join(root, 'tests'),
        file: path.join(root, 'tests', 'auth', 'login.spec.ts'),
        titles: ['Auth', 'signs in'],
      }),
    ).toBe(
      path.join(
        root,
        'demoflow',
        'playwright',
        'auth',
        'login-spec',
        'auth-signs-in.demo.json',
      ),
    );
  });

  it('adds the project slug when there are several', () => {
    expect(
      scenarioPath({
        configDir: root,
        testDir: root,
        file: path.join(root, 'login.spec.ts'),
        titles: ['signs in'],
        project: 'Mobile Chrome',
      }),
    ).toBe(
      path.join(
        root,
        'demoflow',
        'playwright',
        'mobile-chrome',
        'login-spec',
        'signs-in.demo.json',
      ),
    );
  });
});

describe('WrittenPaths', () => {
  it('fails the second test that reaches the same path', () => {
    const written = new WrittenPaths();
    const file = path.join(root, 'demoflow', 'a.demo.json');
    written.claim(file, 'Signs in', 'demoflow/a.demo.json');
    expect(() =>
      written.claim(file, 'Signs  in', 'demoflow/a.demo.json'),
    ).toThrow('demoflow: demoflow/a.demo.json is already written by "Signs in"');
  });

  it('lets the same test write again (a retry)', () => {
    const written = new WrittenPaths();
    written.claim('/a', 'Signs in', 'a');
    expect(() => written.claim('/a', 'Signs in', 'a')).not.toThrow();
  });
});

describe('toSlashes', () => {
  it('normalises Windows paths and file URLs', () => {
    expect(toSlashes('C:\\a\\b.ts')).toBe('C:/a/b.ts');
    expect(toSlashes('file:///C:/a/b%20c.ts')).toBe('C:/a/b c.ts');
    expect(toSlashes('file:///home/a/b.ts')).toBe('/home/a/b.ts');
  });
});
