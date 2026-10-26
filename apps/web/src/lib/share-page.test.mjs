import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chapterTime,
  hasUnlockCookie,
  samePath,
  sharePageState,
  shareShape,
  unfurlsVideo,
  unlockOutcome,
} from './share-page.ts';

const share = {
  title: 'Sign in',
  description: null,
  chapters: [],
  format: 'mp4',
  kind: 'video',
  width: 1920,
  height: 1080,
  durationMs: 12000,
  sizeBytes: 1024,
  expiresAt: '2026-11-01T00:00:00.000Z',
  fileUrl: 'https://demoflow.example/s/abc/file',
  posterUrl: 'https://demoflow.example/s/abc/poster',
  downloadUrl: 'https://demoflow.example/s/abc/file?download=1',
};

test('an open share renders the share', () => {
  assert.deepEqual(sharePageState(200, share), { kind: 'share', share });
});

test('a locked answer renders the password form only', () => {
  assert.deepEqual(sharePageState(200, { locked: true }), { kind: 'locked' });
});

test('an unknown token is not found', () => {
  assert.deepEqual(sharePageState(404, { error: 'not-found' }), {
    kind: 'not-found',
  });
});

test('a 410 tells an expired link from an unavailable video', () => {
  assert.deepEqual(sharePageState(410, { error: 'expired' }), {
    kind: 'expired',
  });
  assert.deepEqual(sharePageState(410, { error: 'unavailable' }), {
    kind: 'unavailable',
  });
  assert.deepEqual(sharePageState(410, undefined), { kind: 'unavailable' });
});

test('anything else is an error, never a share', () => {
  assert.deepEqual(sharePageState(500, undefined), { kind: 'error' });
  assert.deepEqual(sharePageState(200, undefined), { kind: 'error' });
  assert.deepEqual(sharePageState(200, { title: 'x' }), { kind: 'error' });
});

test('chapter times read mm:ss, and h:mm:ss from an hour on', () => {
  assert.equal(chapterTime(0), '00:00');
  assert.equal(chapterTime(4_999), '00:04');
  assert.equal(chapterTime(65_000), '01:05');
  assert.equal(chapterTime(3_725_000), '1:02:05');
  assert.equal(chapterTime(-10), '00:00');
});

test('the player box follows the picture', () => {
  assert.equal(shareShape(1920, 1080), 'landscape');
  assert.equal(shareShape(1080, 1920), 'vertical');
  assert.equal(shareShape(1080, 1080), 'square');
  assert.equal(shareShape(null, null), 'landscape');
  assert.equal(shareShape(0, 1080), 'landscape');
});

test('in-page URLs keep the path and query only', () => {
  assert.equal(samePath(share.fileUrl), '/s/abc/file');
  assert.equal(samePath(share.downloadUrl), '/s/abc/file?download=1');
  assert.equal(samePath('/s/abc/file'), '/s/abc/file');
});

test('an unlock cookie is spotted among others', () => {
  assert.equal(hasUnlockCookie(''), false);
  assert.equal(hasUnlockCookie('df_session=1; theme=dark'), false);
  assert.equal(hasUnlockCookie('theme=dark; df_share_abc=1.sig'), true);
});

test('og:video goes only to MP4 shares read without an unlock cookie', () => {
  assert.equal(unfurlsVideo(share, ''), true);
  assert.equal(unfurlsVideo({ ...share, format: 'mp4-vertical' }, ''), true);
  assert.equal(unfurlsVideo({ ...share, format: 'webm' }, ''), false);
  assert.equal(
    unfurlsVideo({ ...share, format: 'gif', kind: 'image' }, ''),
    false,
  );
  assert.equal(unfurlsVideo(share, 'df_share_abc=1.sig'), false);
});

test('unlock answers map to their messages', () => {
  assert.equal(unlockOutcome(204), 'unlocked');
  assert.equal(unlockOutcome(401), 'wrong-password');
  assert.equal(unlockOutcome(400), 'wrong-password');
  assert.equal(unlockOutcome(429), 'rate-limited');
  assert.equal(unlockOutcome(410), 'changed');
  assert.equal(unlockOutcome(404), 'changed');
  assert.equal(unlockOutcome(500), 'error');
});
