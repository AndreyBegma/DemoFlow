import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCS_NAV, docsPageFile } from './docs-nav.ts';

const appDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'app',
);

test('every docs nav entry resolves to a page', () => {
  assert.ok(DOCS_NAV.length > 0);
  for (const { href } of DOCS_NAV) {
    const file = path.join(appDir, docsPageFile(href));
    assert.ok(existsSync(file), `${href} has no page at ${file}`);
  }
});

test('docs nav entries are unique and under /docs', () => {
  const hrefs = DOCS_NAV.map((entry) => entry.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
  for (const href of hrefs) {
    assert.match(href, /^\/docs(\/[a-z-]+)?$/);
  }
});
