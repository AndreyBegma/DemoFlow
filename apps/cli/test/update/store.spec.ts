import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostEnvironment } from '../../src/config/platform.ts';
import { fileSkipStore, updateStorePath } from '../../src/update/store.ts';

let dir: string;
let host: HostEnvironment;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'demoflow-update-'));
  host = { platform: 'linux', env: { XDG_CONFIG_HOME: dir }, homedir: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fileSkipStore', () => {
  it('lives beside the global config.json', () => {
    expect(updateStorePath(host)).toBe(
      path.join(dir, 'demoflow', 'update.json'),
    );
    expect(
      updateStorePath({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
        homedir: 'C:\\Users\\Ada',
      }),
    ).toBe('C:\\Users\\Ada\\AppData\\Roaming\\demoflow\\update.json');
  });

  it('writes the skipped version and reads it back', async () => {
    const store = fileSkipStore(host);
    expect(store.read()).toBeUndefined();
    store.write('0.2.0');
    expect(store.read()).toBe('0.2.0');
    expect(JSON.parse(await readFile(updateStorePath(host), 'utf8'))).toEqual({
      skipVersion: '0.2.0',
    });
  });

  it('treats a malformed file as no skip', async () => {
    const store = fileSkipStore(host);
    store.write('0.2.0');
    await writeFile(updateStorePath(host), '{ nope');
    expect(store.read()).toBeUndefined();
  });

  it('does not throw when the file cannot be written', async () => {
    // The config directory is a file: mkdir fails.
    await writeFile(path.join(dir, 'demoflow'), '');
    const store = fileSkipStore(host);
    expect(() => store.write('0.2.0')).not.toThrow();
    expect(store.read()).toBeUndefined();
  });
});
