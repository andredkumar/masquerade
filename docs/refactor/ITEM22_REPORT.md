# Item 22 report — image-batch output mislabel, FIXED

**Status:** implemented, local gates green, **not yet deployed and not yet verified on the box.**
This report is the handoff: §5 is the work the next agent (or operator) must do before this can be
called done in prod.

**Base:** `main @ 21e588b`. One commit, one revert.
**Decision authority:** `docs/refactor/ITEM22_RECON.md` §6 — "proceed, with three amendments."
All three amendments are incorporated (ZIP verification 6.2, item 27 filed not fixed 6.3, local
test 6.4).

---

## 1. What was wrong

The backlog entry described a fallback-only bug. Recon §1 established it was on the **default path
of every image job**, in both directions, from one root cause:

| Path | Upload | Bytes | Filename | |
|---|---|---|---|---|
| Main (`:848 → processFrameBatch → :1786`) | `photo.png` | JPEG q90 | `image_001_photo.png` | ❌ common case |
| Main | `photo.jpg` | JPEG q90 | `image_001_photo.jpg` | ✅ by accident |
| Main, PNG selected | `photo.jpg` | PNG | `image_001_photo.jpg` | ❌ |
| Fallback (`:923 → processFrame → :2059`) | `photo.jpg` | PNG | `image_001_photo.jpg` | ❌ the only case the backlog described |

Root cause: `saveProcessedImage` derived the extension from the **upload**, never the encoder.

Recon §6.2 found it did not stop at the temp folder — ZIP entry names come from the on-disk
extension (`routes.ts:675` `fileExt()`, `:805` `archive.file(... name: images/frame_%06d.${ext})`),
so a default-settings job exported `images/frame_000000.png` holding JPEG bytes **inside the
training-data artifact**. That is what turned "worth deferring" into "worth one deploy."

---

## 2. What changed

Four edits, exactly as recon §3 specified. `git diff --stat server/` → 21 insertions, 9 deletions.

| # | File | Change |
|---|---|---|
| 1 | `videoProcessor.ts:2058` | Fallback encoder honors `outputSettings.format`, using the batch encoder's constants (`:1783`) — JPEG q90 default, PNG `compressionLevel: 3, adaptiveFiltering: false` opt-in. No new constants. |
| 2 | `templateMaskFolderManager.ts:72` | `saveProcessedImage` takes a **required** `outputFormat: 'png' \| 'jpg'` and derives the extension from it; basename still from the upload. Mirrors the video path's `ext` at `videoProcessor.ts:516`. |
| 3 | `videoProcessor.ts:820, 869, 933` | One named local `outputExt` beside the `outputSize` block; both call sites pass it. |
| 4 | `CLAUDE.md:636` | Item 22 **rewritten** (see §3). |

The new arg is required rather than optional **on purpose**: `tsc` fails on a missed call site.
Both call sites are updated; there are no others (repo-wide grep, no test fixtures assert the
naming).

**No reader changes.** `listFrameFiles` / `countFrames` / `getProcessedImages` already accept
`png|jpg|jpeg`; `mimeForFrameFile` derives Content-Type from the extension. The ZIP inherits the fix
with no code change, because its entry names follow the on-disk extension.

### New test

`server/services/__tests__/saveProcessedImage.test.ts` — `node:test` + `npx tsx`, matching
`frameAccess.test.ts`'s convention (no runner in `package.json`). **No DB, no ffmpeg, no Sharp.**

`SPOKE_TEMPLATE_MASK_DIR` is `path.resolve(process.cwd(), …)` captured at module load, so the test
`process.chdir()`s into an OS temp dir **before** importing the manager and writes nothing into the
repo.

11 tests: the 8 upload-ext × output-format cases, plus multi-dot basename preservation
(`scan.2026-09-04.v2.png` → `image_001_scan.2026-09-04.v2.jpg`), the 1-based `padStart(3)` index,
and a bytes round-trip.

**Confirmed genuinely red.** Reverting only the naming logic and re-running: **8 fail / 3 pass**.
Restored: **11 pass**. The 3 that pass either way are the accidentally-correct combinations.

---

## 3. CLAUDE.md changes

**Item 22 — rewritten, not struck through** (recon §1 made this a requirement: the original
description was wrong, so a strikethrough would have preserved a false account). The new entry
opens by saying so, corrects the stale `videoProcessor.ts:1801` → `:2059`, states the
both-directions behavior, records the ZIP propagation, names the test, and states that pre-fix
files on disk are **not** migrated — `mimeForFrameFile`'s PNG fallback keeps them viewable for
their retention window.

**Item 27 — filed, not fixed** (recon §6.3 text verbatim, plus provenance). Manifest filenames
don't resolve inside the export ZIP: `frameManifest.ts:72` emits `frame_%04d.<fmt>` while
`routes.ts:803` writes `images/frame_%06d.<ext>` — wrong pad width, no `images/` prefix, in both
`manifest.json` and `metadata.csv`, on both download paths. Changes manifest bytes, so it breaks
the Phase 6 D1 byte-identical guarantee deliberately and needs its own gate.

**⚠️ For whoever verifies this deploy:** the manifest filenames in the ZIP still will not resolve.
That is item 27, pre-existing and deliberately untouched here — **do not read it as a regression
from this commit.**

---

## 4. Local gates — all green

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **12** (5 `frameExtractor.ts`, 7 `maskWorker.ts`) — invariant held |
| `npx tsx server/services/__tests__/applyPaths.test.ts` | 8 pass / 0 fail |
| `npx tsx server/services/__tests__/frameAccess.test.ts` | 8 pass / 0 fail |
| `npx tsx server/services/__tests__/saveProcessedImage.test.ts` | 11 pass / 0 fail |
| `npm run build` | ✓ `dist/index.js` 227.1kb |

Per the toolchain constraint (no ffmpeg, no Postgres on the dev Mac), `processImages` **cannot** be
run end to end locally — `storage.getVideoJob` blocks it. Everything below is therefore unverified
until it runs on the box.

---

## 5. Handoff — on-box verification, REQUIRED before this is done

Upload a mixed 3-image batch (`.jpg`, `.jpeg`, `.png`) and apply a mask. **Run the whole sequence
twice: once with default settings, once with PNG selected in the UI.**

**5.1 On-disk names match content**

```bash
file spokes/template_mask/<jobId>/*
```

Default run → all three `JPEG image data`, all named `.jpg`.
PNG run → all three `PNG image data`, all named `.png`.

**5.2 The ZIP carries the same truth** (recon §6.2 — the amendment that justified the deploy)

```bash
rm -rf /tmp/zipcheck && unzip -o processed_<name>.zip -d /tmp/zipcheck && file /tmp/zipcheck/images/*
```

Every `images/*` entry's reported type must match its extension, on **both** runs. A
type/extension disagreement in either place — on disk or in the archive — is a fail.

**5.3 Optional, not a gate** (recon §6.5 disposition 3)

```bash
pm2 logs masquerade --lines 200000 --nostream --raw | grep -c "Fallback processed image"
```

Tells you whether the `catch` fallback has ever fired in prod — i.e. whether any job on disk has
PNG-in-`.jpg` rather than JPEG-in-`.png`. Edits 2+3 are the real fix and stand either way.

---

## 6. Blast radius and rollback

**Expected behavior change.** Default image output is now JPEG bytes in `.jpg` files. For a `.png`
upload under default settings this is a **filename** change only — the bytes were already JPEG.
For the fallback branch it is a genuine bytes change (PNG → JPEG q90).

**Old jobs are not migrated.** Deliberate, per the backlog entry and recon §6.5 disposition 4.

**Untouched:** the video path, `shared/schema.ts`, `server/storage.ts`, `server/pgStorage.ts`,
`migrations/` — A3 frozen. Also untouched by design: the manifest/ZIP mismatch (item 27) and the
`output/debug_frame_0_*` dumps at `videoProcessor.ts:2062` (recon §6.5 disposition 2 — those fire
in prod on the fallback path; dev cruft, separate cleanup).

**Rollback:** single commit, `git revert`. No data implications, no schema change.
