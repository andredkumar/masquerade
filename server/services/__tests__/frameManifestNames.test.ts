/**
 * Output Round 2 (R2, backlog 27) — the manifest core passes the ZIP entry names through untouched
 * (docs/refactor/OUTPUT_ROUND2_SIGNOFF.md §3.3): frames[i].filename and the CSV `filename` column are filenames[i], and
 * the core synthesizes nothing.
 * Run:  npx tsx server/services/__tests__/frameManifestNames.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerFrameManifestAndCsv, imageEntryName } from '../../handlers/frameManifest';

test('imageEntryName is images/frame_%06d.<ext>', () => {
  assert.equal(imageEntryName(0, 'jpg'), 'images/frame_000000.jpg');
  assert.equal(imageEntryName(347, 'png'), 'images/frame_000347.png');
  assert.equal(imageEntryName(1234567, 'png'), 'images/frame_1234567.png');
});

test('core passes filenames through to frames[] and the CSV, one per frame, in order', () => {
  const filenames = ['images/frame_000000.jpg', 'images/frame_000001.png', 'images/frame_000002.jpg'];
  const { frames, csv } = buildPerFrameManifestAndCsv({ filenames, labels: [] });
  assert.deepEqual(frames.map(f => f.filename), filenames);
  assert.deepEqual(frames.map(f => f.frame_number), [0, 1, 2]);
  const rows = csv.split('\n');
  assert.equal(rows.length, 1 + filenames.length);
  assert.equal(rows[0].split(',')[0], 'filename');
  assert.deepEqual(rows.slice(1).map(r => r.split(',')[0]), filenames);
});

test('no frames → no rows, header only', () => {
  const { frames, csv } = buildPerFrameManifestAndCsv({ filenames: [], labels: [] });
  assert.equal(frames.length, 0);
  assert.equal(csv.split('\n').length, 1);
});
