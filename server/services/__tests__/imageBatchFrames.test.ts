/**
 * Item 28 — image-batch frame resolution for GET /api/jobs/:jobId/frames/:n.
 *
 * Image batches never populate `temp_extracted/`; the frames endpoint serves
 * them straight from `uploads/<fileList[n].filename>`. The load-bearing
 * property is CO-INDEXING: `processImages` masks in `fileList` order
 * (videoProcessor.ts:827-846), so canvas frame i must be `fileList[i]` and
 * never the i-th name in a sorted directory listing — `uploads/` interleaves
 * every job's files, so a sorted read would silently mis-pair the canvas with
 * the masked output.
 *
 * Filesystem only — no ffmpeg, no Sharp, no DB.
 *
 * Run:  npx tsx server/services/__tests__/imageBatchFrames.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { promises as fs } from 'fs';

import { resolveImageBatchFrame, type ImageBatchEntry } from '../frameAccess';
import { UPLOADS_DIR } from '../cleanup';

// resolveImageBatchFrame resolves against the real UPLOADS_DIR (module-level
// const, pinned to cwd at import). Rather than fight that, write fixtures into
// it under a unique prefix and remove exactly those files afterwards.
const PREFIX = `masq-item28-${process.pid}-`;
const written: string[] = [];

/** Smallest valid PNG (1x1 greyscale) — the byte at `tag` makes each copy distinguishable. */
function distinctBytes(tag: number): Buffer {
  return Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==', 'base64'),
    Buffer.from([tag]),
  ]);
}

async function writeFixture(name: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const p = path.join(UPLOADS_DIR, name);
  await fs.writeFile(p, bytes);
  written.push(p);
}

function entry(filename: string, extra: Partial<ImageBatchEntry> = {}): ImageBatchEntry {
  return { filename, originalName: 'scan.png', type: 'image/png', ...extra };
}

test('co-indexing: frame i is fileList[i], not the i-th sorted filename', async () => {
  // Names sort as aaa < mmm < zzz, but fileList deliberately orders them
  // zzz, aaa, mmm. An implementation that sorted the directory would return
  // aaa for index 0 and fail here. This is the whole test.
  const names = [`${PREFIX}zzz`, `${PREFIX}aaa`, `${PREFIX}mmm`];
  for (let i = 0; i < names.length; i++) await writeFixture(names[i], distinctBytes(i));

  const fileList = names.map(n => entry(n));
  assert.deepEqual([...names].sort(), [names[1], names[2], names[0]], 'fixture ordering assumption');

  for (let i = 0; i < names.length; i++) {
    const r = await resolveImageBatchFrame(fileList, i);
    assert.equal(r.ok, true, `index ${i} should resolve`);
    if (!r.ok) return;
    assert.equal(path.basename(r.absPath), names[i], `index ${i} must map to fileList[${i}]`);
    const bytes = await fs.readFile(r.absPath);
    assert.equal(bytes[bytes.length - 1], i, `index ${i} must carry fileList[${i}]'s bytes`);
  }
});

test('past the end is out_of_range (404), not missing_file', async () => {
  const name = `${PREFIX}single`;
  await writeFixture(name, distinctBytes(9));
  const fileList = [entry(name)];

  for (const n of [1, 2, 99]) {
    const r = await resolveImageBatchFrame(fileList, n);
    assert.deepEqual(r, { ok: false, kind: 'out_of_range' }, `index ${n}`);
  }
  // Single-image batch still serves index 0 (plan §4 row 5).
  assert.equal((await resolveImageBatchFrame(fileList, 0)).ok, true);
});

test('entry present but file swept is missing_file (410), not out_of_range', async () => {
  const name = `${PREFIX}swept`;
  await writeFixture(name, distinctBytes(1));
  await fs.rm(path.join(UPLOADS_DIR, name));

  const r = await resolveImageBatchFrame([entry(name)], 0);
  assert.deepEqual(r, { ok: false, kind: 'missing_file' });
});

test('traversal in filename is refused without throwing', async () => {
  for (const bad of ['../../etc/passwd', '..', '.', 'sub/dir/x.png', 'nul\0byte.png', '']) {
    const r = await resolveImageBatchFrame([{ filename: bad }], 0);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not resolve`);
    if (!r.ok) assert.equal(r.kind, 'out_of_range');
  }
});

test('browser-supplied mimetype is never reflected verbatim', async () => {
  const name = `${PREFIX}xss`;
  await writeFixture(name, distinctBytes(2));

  // fileFilter admits this: mimetype is rejected but the .png extension passes.
  // Echoing text/html would serve these bytes as HTML from the app's origin.
  const evil = await resolveImageBatchFrame(
    [entry(name, { type: 'text/html', originalName: 'photo.png' })], 0);
  assert.equal(evil.ok, true);
  if (evil.ok) assert.equal(evil.contentType, 'image/png');

  const svg = await resolveImageBatchFrame(
    [entry(name, { type: 'image/svg+xml', originalName: 'photo.jpg' })], 0);
  assert.equal(svg.ok, true);
  if (svg.ok) assert.equal(svg.contentType, 'image/jpeg');

  // Legitimate types survive; image/jpg is normalized to image/jpeg.
  const jpeg = await resolveImageBatchFrame([entry(name, { type: 'image/jpeg' })], 0);
  if (jpeg.ok) assert.equal(jpeg.contentType, 'image/jpeg');
  const jpg = await resolveImageBatchFrame([entry(name, { type: 'image/jpg' })], 0);
  if (jpg.ok) assert.equal(jpg.contentType, 'image/jpeg');
});

test('malformed fileList never crashes the endpoint', async () => {
  const cases: unknown[] = [null, undefined, [], {}, 'not-an-array', [null], [{}], [{ filename: 7 }]];
  for (const c of cases) {
    const r = await resolveImageBatchFrame(c, 0);
    assert.deepEqual(r, { ok: false, kind: 'out_of_range' }, JSON.stringify(c) ?? 'undefined');
  }
  // Negative / non-integer indices are rejected before any filesystem access.
  assert.equal((await resolveImageBatchFrame([entry('x')], -1)).ok, false);
  assert.equal((await resolveImageBatchFrame([entry('x')], 1.5)).ok, false);
});

test.after(async () => {
  for (const p of written) await fs.rm(p, { force: true });
});
