import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProjectConfig, parseScenario } from '@demoflow/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initCommand } from '../../src/commands/init.ts';
import type { Io } from '../../src/commands/io.ts';
import { main } from '../../src/main.ts';

let dir: string;
let project: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'demoflow-init-')));
  project = path.join(dir, 'project');
  mkdirSync(project);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capture(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

const CONFIG = 'demoflow.config.json';
const SCENARIO = path.join('demoflow', 'first.demo.json');

function read(file: string): string {
  return readFileSync(path.join(project, file), 'utf8');
}

describe('demoflow init', () => {
  it('writes a config and a first scenario that both parse cleanly', async () => {
    const io = capture();
    expect(await initCommand({}, io, { cwd: project })).toBe(0);

    const config = parseProjectConfig(JSON.parse(read(CONFIG)));
    expect(config.ok && config.value.baseUrl).toBe('http://localhost:3000');
    expect(config.ok && config.warnings).toEqual([]);
    const scenario = parseScenario(JSON.parse(read(SCENARIO)));
    expect(scenario.ok && scenario.warnings).toEqual([]);

    expect(io.out).toContain('created demoflow.config.json\n');
    expect(io.out).toContain('created demoflow/first.demo.json\n');
    expect(io.out).toContain('demoflow check');
    expect(io.out).toContain('demoflow run demoflow/first.demo.json');
    expect(io.out).toContain('demoflow record');
  });

  it('writes --base-url as given', async () => {
    const io = capture();
    const flags = { baseUrl: 'http://localhost:5173' };
    expect(await initCommand(flags, io, { cwd: project })).toBe(0);
    expect(JSON.parse(read(CONFIG))).toEqual({
      baseUrl: 'http://localhost:5173',
    });
  });

  it('exits 2 on an invalid --base-url and writes nothing', async () => {
    const io = capture();
    expect(
      await initCommand({ baseUrl: 'not-a-url' }, io, { cwd: project }),
    ).toBe(2);
    expect(io.err).toContain('baseUrl');
    expect(readdirSync(project)).toEqual([]);
  });

  it('keeps an existing config byte-for-byte and still creates the scenario', async () => {
    writeFileSync(path.join(project, CONFIG), '{ "custom": true }');
    const io = capture();
    expect(await initCommand({}, io, { cwd: project })).toBe(0);
    expect(read(CONFIG)).toBe('{ "custom": true }');
    expect(io.out).toContain('kept demoflow.config.json\n');
    expect(io.out).toContain('created demoflow/first.demo.json\n');
  });

  it('keeps an existing scenario byte-for-byte and still creates the config', async () => {
    mkdirSync(path.join(project, 'demoflow'));
    writeFileSync(path.join(project, SCENARIO), 'mine');
    const io = capture();
    expect(await initCommand({}, io, { cwd: project })).toBe(0);
    expect(read(SCENARIO)).toBe('mine');
    expect(io.out).toContain('created demoflow.config.json\n');
    expect(io.out).toContain('kept demoflow/first.demo.json\n');
  });

  it('exits 0 and writes nothing when both files exist', async () => {
    mkdirSync(path.join(project, 'demoflow'));
    writeFileSync(path.join(project, CONFIG), 'a');
    writeFileSync(path.join(project, SCENARIO), 'b');
    const io = capture();
    expect(await initCommand({}, io, { cwd: project })).toBe(0);
    expect(read(CONFIG)).toBe('a');
    expect(read(SCENARIO)).toBe('b');
    expect(io.out).toContain('kept demoflow.config.json\n');
    expect(io.out).toContain('kept demoflow/first.demo.json\n');
  });

  it('ignores a config in a parent directory', async () => {
    writeFileSync(path.join(dir, CONFIG), '{ "baseUrl": "http://parent:1" }');
    const io = capture();
    expect(await initCommand({}, io, { cwd: project })).toBe(0);
    expect(io.out).toContain('created demoflow.config.json\n');
    expect(JSON.parse(read(CONFIG))).toEqual({
      baseUrl: 'http://localhost:3000',
    });
    expect(readFileSync(path.join(dir, CONFIG), 'utf8')).toBe(
      '{ "baseUrl": "http://parent:1" }',
    );
  });

  it('lists --base-url in --help', async () => {
    const io = capture();
    expect(await main(['init', '--help'], io)).toBe(0);
    expect(io.out).toContain('--base-url');
  });
});
