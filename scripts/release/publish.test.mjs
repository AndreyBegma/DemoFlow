// node --test scripts/release/ — Node's own runner, not `bun test`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./publish.sh', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'publish-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs publish.sh against a stub npm that prints `output` and exits `code`. */
function publish(output, code, tag = 'latest') {
  const stub = join(dir, 'npm');
  const args = join(dir, 'args');
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$@" > '${args}'\nprintf '%s\\n' '${output}' >&2\nexit ${code}\n`,
  );
  chmodSync(stub, 0o755);
  const run = spawnSync('sh', [script, 'apps/cli/dist/npm', tag], {
    encoding: 'utf8',
    env: { ...process.env, NPM: stub },
  });
  return {
    status: run.status,
    out: run.stdout,
    args: readFileSync(args, 'utf8').trim(),
  };
}

describe('release publish.sh', () => {
  test('publishes the staged directory, public, with the dist-tag it was given', () => {
    const run = publish('+ demoflow@0.1.0', 0, 'v0.1');
    assert.equal(run.status, 0);
    assert.equal(
      run.args,
      'publish apps/cli/dist/npm --ignore-scripts --access public --tag v0.1',
    );
  });

  test('a 409 over a staged version passes: the registry holds it', () => {
    const run = publish(
      'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/demoflow - Cannot publish over previously staged version "0.1.0".',
      1,
    );
    assert.equal(run.status, 0);
    assert.match(run.out, /treating it as published/);
  });

  test('EPUBLISHCONFLICT passes too', () => {
    assert.equal(publish('npm error code EPUBLISHCONFLICT', 1).status, 0);
  });

  test("any other failure fails, with npm's exit code", () => {
    assert.equal(
      publish('npm error code E403\nnpm error 403 Forbidden', 1).status,
      1,
    );
  });

  test('without a directory and a dist-tag it is a usage error', () => {
    assert.equal(spawnSync('sh', [script, 'latest']).status, 2);
  });
});
