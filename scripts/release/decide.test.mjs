// node --test scripts/release/ — Node's own runner, not `bun test`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./decide.sh', import.meta.url));

function decide(version, published, latest, branch) {
  const run = spawnSync('sh', [script, version, published, latest, branch], {
    encoding: 'utf8',
  });
  const out = {};
  for (const line of run.stdout.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key) out[key] = rest.join('=');
  }
  return { status: run.status, out };
}

describe('release decide.sh', () => {
  test('the first publish, with nothing on the registry, is latest', () => {
    assert.deepEqual(decide('0.1.0', 'no', '', 'main').out, {
      publish: 'yes',
      npm_tag: 'latest',
      git_tag: 'v0.1.0',
    });
  });

  test('a version bump on main publishes as latest and tags it', () => {
    assert.deepEqual(decide('0.2.0', 'no', '0.1.0', 'main').out, {
      publish: 'yes',
      npm_tag: 'latest',
      git_tag: 'v0.2.0',
    });
  });

  test('main without a version bump publishes nothing', () => {
    const { status, out } = decide('0.1.0', 'yes', '0.1.0', 'main');
    assert.equal(status, 0);
    assert.equal(out.publish, 'no');
  });

  test('maint/v0.1 never publishes as latest', () => {
    assert.deepEqual(decide('0.1.9', 'no', '0.2.0', 'maint/v0.1').out, {
      publish: 'yes',
      npm_tag: 'v0.1',
      git_tag: 'v0.1.9',
    });
  });

  test('a tag push (no branch) below latest is a maint line', () => {
    assert.equal(decide('0.1.9', 'no', '0.2.0', '').out.npm_tag, 'v0.1');
  });

  test('versions compare numerically, not as strings', () => {
    assert.equal(decide('0.9.0', 'no', '0.24.0', '').out.npm_tag, 'v0.9');
    assert.equal(decide('0.100.0', 'no', '0.24.0', '').out.npm_tag, 'latest');
  });

  test('rejects a malformed version', () => {
    assert.equal(decide('main', 'no', '0.1.0', 'main').status, 2);
  });
});
