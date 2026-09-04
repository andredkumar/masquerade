/**
 * Backlog item 22 regression test — masked image files must be named after the
 * *encoder*, not the upload.
 *
 * Before the fix, `saveProcessedImage` derived the extension from the uploaded
 * filename (`path.extname(originalName) || '.png'`), so a JPEG-encoded
 * `photo.png` was written as `image_001_photo.png` — and, because the ZIP entry
 * name is derived from the on-disk extension (`routes.ts:675/805`), the lie was
 * exported into the dataset archive as `images/frame_000000.png` holding JPEG
 * bytes.
 *
 * Filesystem only — no Sharp, no ffmpeg, no DB. `SPOKE_TEMPLATE_MASK_DIR` is
 * `path.resolve(process.cwd(), 'spokes/template_mask')`, resolved once at module
 * load, so this chdirs into a sandbox BEFORE importing the manager and writes
 * nothing into the repo.
 *
 * Run:  npx tsx server/services/__tests__/saveProcessedImage.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'masq-savedimage-'));
const repoCwd = process.cwd();
process.chdir(sandbox);

// Imported only after the chdir — TEMP_BASE is captured at module load.
const { TempFolderManager } = await import('../templateMaskFolderManager');

process.chdir(repoCwd);

const BYTES = Buffer.from('not-a-real-image');

/** Save one image and return its basename. */
async function savedName(
  jobId: string,
  originalName: string,
  outputFormat: 'png' | 'jpg',
): Promise<string> {
  const p = await TempFolderManager.saveProcessedImage(jobId, 0, BYTES, originalName, outputFormat);
  return path.basename(p);
}

// ── The 8 cases: upload ext {.jpg, .jpeg, .png, none} × format {jpg, png} ──
//
// The extension column is the whole point: it tracks `outputFormat` and never
// the upload. The basename column proves the upload's name still survives.

const CASES: Array<{ upload: string; format: 'png' | 'jpg'; expected: string }> = [
  // JPEG encoder — every upload extension lands on `.jpg`
  { upload: 'photo.jpg',  format: 'jpg', expected: 'image_001_photo.jpg' },
  { upload: 'photo.jpeg', format: 'jpg', expected: 'image_001_photo.jpg' },
  { upload: 'photo.png',  format: 'jpg', expected: 'image_001_photo.jpg' }, // the pre-fix bug
  { upload: 'photo',      format: 'jpg', expected: 'image_001_photo.jpg' },
  // PNG encoder — every upload extension lands on `.png`
  { upload: 'photo.jpg',  format: 'png', expected: 'image_001_photo.png' }, // the pre-fix bug
  { upload: 'photo.jpeg', format: 'png', expected: 'image_001_photo.png' },
  { upload: 'photo.png',  format: 'png', expected: 'image_001_photo.png' },
  { upload: 'photo',      format: 'png', expected: 'image_001_photo.png' },
];

for (const [i, { upload, format, expected }] of CASES.entries()) {
  test(`"${upload}" encoded as ${format} → ${expected}`, async () => {
    const name = await savedName(`case-${i}`, upload, format);
    assert.equal(name, expected);
    assert.equal(
      path.extname(name),
      `.${format}`,
      'extension must follow the encoder, never the upload',
    );
  });
}

// ── Basename preservation ────────────────────────────────────────────────

test('a multi-dot basename keeps everything but the final extension', async () => {
  // `path.extname` strips only `.gz`, so the rest of the name must survive.
  assert.equal(
    await savedName('multidot', 'scan.2026-09-04.v2.png', 'jpg'),
    'image_001_scan.2026-09-04.v2.jpg',
  );
});

test('index is 1-based and zero-padded to 3', async () => {
  const p = await TempFolderManager.saveProcessedImage('padding', 41, BYTES, 'a.png', 'jpg');
  assert.equal(path.basename(p), 'image_042_a.jpg');
});

// ── The file actually lands where the name says ──────────────────────────

test('the written file exists at the returned path with the given bytes', async () => {
  const p = await TempFolderManager.saveProcessedImage('roundtrip', 0, BYTES, 'x.png', 'jpg');
  assert.deepEqual(await fs.readFile(p), BYTES);
  assert.ok(p.endsWith(path.join('spokes', 'template_mask', 'roundtrip', 'image_001_x.jpg')));
});

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});
