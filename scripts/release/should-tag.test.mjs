// node --test scripts/release/ — Node's own runner, not `bun test`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./should-tag.sh', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'should-tag-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function shouldTag(decision, tagExists) {
  const file = join(dir, 'decision');
  if (decision !== null) writeFileSync(file, decision);
  const path = decision === null ? join(dir, 'missing') : file;
  const run = spawnSync('sh', [script, path, tagExists], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout.trim() };
}

describe('release should-tag.sh', () => {
  test('published now: tag, even though the registry may not show it yet', () => {
    assert.deepEqual(shouldTag('publish=yes\nversion=0.1.0\n', 'no'), {
      status: 0,
      out: 'tag=yes',
    });
  });

  test('already published, no tag yet: tag (idempotent re-run)', () => {
    assert.equal(shouldTag('publish=no\nversion=0.1.0\n', 'no').out, 'tag=yes');
  });

  test('no version bump: the version is published and tagged, no tag', () => {
    assert.equal(shouldTag('publish=no\nversion=0.1.0\n', 'yes').out, 'tag=no');
  });

  test('no decision recorded (publish step skipped): no tag', () => {
    assert.deepEqual(shouldTag(null, 'no'), { status: 0, out: 'tag=no' });
  });

  test('a decision without a version is an error', () => {
    assert.equal(shouldTag('publish=yes\n', 'no').status, 2);
  });
});
