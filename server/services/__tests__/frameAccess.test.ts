/**
 * Round 2A regression test for the frame-0 unblock race guard.
 *
 * The frames endpoint may now read `temp_extracted/<jobId>/` while
 * `startBackgroundFrameExtraction` is still writing that batch's files with
 * concurrent `fs.writeFile`s, so a read can land on a partially written PNG.
 * `isCompletePng` is the whole guard: a truncated PNG has no IEND trailer.
 *
 * Filesystem only — no ffmpeg, no Sharp, no DB.
 *
 * Run:  npx tsx server/services/__tests__/frameAccess.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

import { isCompletePng, isCompletePngBuffer } from '../frameAccess';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'masq-framecomplete-'));

/**
 * Smallest valid PNG: 1x1 greyscale. Ends with the IEND chunk, exactly like
 * every frame ffmpeg's image2 muxer and Sharp write.
 */
const WHOLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==',
  'base64',
);

async function writeFixture(name: string, buf: Buffer): Promise<string> {
  const p = path.join(sandbox, name);
  await fs.writeFile(p, buf);
  return p;
}

// ── RED: the cases the guard exists to catch ─────────────────────────────

test('isCompletePng REJECTS a PNG truncated mid-write', async () => {
  // Simulate a writeFile caught in flight: header present, IEND not yet.
  const partial = WHOLE_PNG.subarray(0, WHOLE_PNG.length - 12);
  const p = await writeFixture('partial.png', partial);
  assert.equal(await isCompletePng(p), false, 'a PNG without its IEND trailer must not be served');
});

test('isCompletePng REJECTS a zero-byte file', async () => {
  // fs.writeFile creates the inode before any bytes land — the readdir can see
  // the name while the file is still empty.
  const p = await writeFixture('empty.png', Buffer.alloc(0));
  assert.equal(await isCompletePng(p), false, 'an empty file must not be served');
});

test('isCompletePng REJECTS a file shorter than the trailer itself', async () => {
  const p = await writeFixture('runt.png', Buffer.from([0x89, 0x50, 0x4e]));
  assert.equal(await isCompletePng(p), false, 'a 3-byte file must not underflow the length check');
});

test('isCompletePng REJECTS a missing file rather than throwing', async () => {
  const p = path.join(sandbox, 'does-not-exist.png');
  assert.equal(await isCompletePng(p), false, 'ENOENT must read as "not ready", not blow up the route');
});

test('isCompletePngBuffer REJECTS trailing bytes that merely contain IEND', async () => {
  // IEND present but not at the end — a truncated write of a longer file that
  // happens to straddle the chunk would look like this.
  const buf = Buffer.concat([WHOLE_PNG, Buffer.from([0x00, 0x01, 0x02])]);
  assert.equal(isCompletePngBuffer(buf), false, 'IEND must be the LAST 8 bytes, not just present');
});

// ── GREEN: the case that must keep working ───────────────────────────────

test('isCompletePng ACCEPTS a whole PNG', async () => {
  const p = await writeFixture('whole.png', WHOLE_PNG);
  assert.equal(await isCompletePng(p), true, 'a complete PNG must be served');
});

test('isCompletePngBuffer ACCEPTS the same bytes without touching disk', () => {
  assert.equal(isCompletePngBuffer(WHOLE_PNG), true, 'buffer form must agree with the path form');
});

test('the fixture is a real PNG (guards the fixture itself)', () => {
  assert.equal(
    WHOLE_PNG.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    'fixture must carry the PNG magic — otherwise the GREEN cases prove nothing',
  );
});

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});
