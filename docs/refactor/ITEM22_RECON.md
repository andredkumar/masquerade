# Item 22 recon — image-batch output mislabel

**Status:** recon only. No code written. This report exists so the next agent can decide
whether to implement, and if so, with the premise corrected.

**Repo state at recon:** `main @ 21e588b`, working tree clean except untracked
`docs/refactor/NEXT_ROUND_CANDIDATES.md`.
**Baseline:** `npx tsc --noEmit` → **12 errors** (5 `frameExtractor.ts`, 7 `maskWorker.ts`). Unchanged.

**Sources read:** `CLAUDE.md:636` (backlog item 22), `docs/refactor/NEXT_ROUND_CANDIDATES.md` (Item 1),
`docs/refactor/ROUND2B_REPORT.md` §A / `ROUND2B_ADDENDUM.md` §A.1–A.2.

---

## 1. The premise in CLAUDE.md and NEXT_ROUND_CANDIDATES is half wrong

Both say: *"`processImages` always encodes PNG (`videoProcessor.ts:1801` / `:2059`) but names the
file from the uploaded file's extension, so a masked `photo.jpg` is PNG bytes in a `.jpg` file."*

`processImages` does **not** always encode PNG. It has two encoders on two branches, and only one
of them is unconditional PNG — the rarer one.

### Call graph (verified)

| Branch | Site | Encoder | Honors `outputSettings.format`? |
|---|---|---|---|
| Main volumetric batch | `videoProcessor.ts:848` → `processFrameBatch` | `:1786–1787` | **Yes** — fixed in Round 2B |
| Per-image `catch` fallback | `videoProcessor.ts:923` → `processFrame` | `:2059` `await processedImage.png().toBuffer()` | **No** — unconditional PNG |

Evidence:

```
$ grep -n "this.processFrame\b\|this.processFrameBatch\|toBuffer()" server/services/videoProcessor.ts
848:          const volumeResults = await this.processFrameBatch(volumeTasks);
923:              const result = await this.processFrame(task);
1159:          const volumeResults = await this.processFrameBatch(volumeTasks);
1295:        const volumeResults = await this.processFrameBatch(volumeTasks, {
1786:          ? await processedImage.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer()
1787:          : await processedImage.jpeg({ quality: 90 }).toBuffer();
1863:        const unprocessedBuffer = await image.png().toBuffer();   // debug dump, frameNumber===0
2059:      const processedBuffer = await processedImage.png().toBuffer();
2076:        }).png().toBuffer();                                      // debug mask viz
```

`processFrame` (`:1848–2095`) has **exactly one caller**: the fallback inside the `catch` at `:923`.
`processFrameBatch` (`:1582–1846`) contains exactly one output encoder (`:1786`), so the image main
path and the video path share the already-fixed encoder.

### Consequence: the mislabel runs in *both* directions

| Path | Upload | Bytes written | Filename | Correct? |
|---|---|---|---|---|
| Main (default settings) | `photo.png` | JPEG q90 | `image_001_photo.png` | **No** — the common case, on every image job since 2B |
| Main (default settings) | `photo.jpg` | JPEG q90 | `image_001_photo.jpg` | Yes, by accident |
| Main (PNG selected) | `photo.jpg` | PNG | `image_001_photo.jpg` | **No** |
| Fallback | `photo.jpg` | PNG | `image_001_photo.jpg` | **No** — the only case the backlog describes |

The backlog entry describes the fallback branch and misses the branch that runs on every normal
image job. **If item 22 is closed, the description at `CLAUDE.md:636` must be rewritten, not just
struck through** — and the line reference `videoProcessor.ts:1801` is stale (the encoder is at
`:2059`).

### Single root cause

`TempFolderManager.saveProcessedImage` (`templateMaskFolderManager.ts:78–86`) derives the extension
from the *upload*, never from the encoder:

```ts
const extension = path.extname(originalName) || '.png';
const filename = `image_${String(imageIndex + 1).padStart(3, '0')}_${path.basename(originalName, extension)}${extension}`;
```

This is why the main path still lies despite its encoder already being correct. The video path
solved the same problem at `videoProcessor.ts:516` (`const ext = outputSettings.format === 'png' ? 'png' : 'jpg'`).

---

## 2. Downstream reader sweep — clean, no reader changes needed

Every consumer of masked frames is already extension-agnostic. Verified:

- `countFrames` (`frameAccess.ts:108`), `listFrameFiles` (`:134`) — filter `/\.(png|jpe?g)$/i`
- `getProcessedImages` (`templateMaskFolderManager.ts:101`) — filters `/\.(png|jpg|jpeg)$/i`
- `mimeForFrameFile` (`frameAccess.ts:176`) — derives Content-Type from the extension, PNG fallback
- All consumers route through those helpers: `routes.ts:613` (download/ZIP), `:901`, `:1603`, `:1884`

The only hardcoded `.png` on any **write** path is the `|| '.png'` default at
`templateMaskFolderManager.ts:84` itself:

```
$ grep -rn "\.png'" server/handlers server/services --include="*.ts" | grep -vi "frame_\|debug\|temp_extracted"
server/services/templateMaskFolderManager.ts:84:    const extension = path.extname(originalName) || '.png';
(remaining hits are all in server/services/__tests__/frameAccess.test.ts fixtures)
```

`mimeForFrameFile`'s PNG fallback (documented as covering "`.png`-named JPEGs written by earlier
deploys") already covers pre-fix jobs for the rest of their retention window.

---

## 3. Candidate change (not written)

Four edits. Root cause is #2; #1 is the fallback branch that would otherwise still disagree with it.

**(1) `videoProcessor.ts:2057–2059`** — make the fallback encoder honor the format, with the same
constants as `processFrameBatch:1783–1787`. No new constants.

```diff
-      // PIPELINE STEP 3: Convert to PNG and output
-      console.log('⚡ Pipeline final step: Converting to PNG buffer');
-      const processedBuffer = await processedImage.png().toBuffer();
+      // PIPELINE STEP 3: encode to the requested output format (backlog 22).
+      // Same constants as the batch encoder at :1783 — JPEG q90 default,
+      // PNG compressionLevel 3 / no adaptive filtering when the user picks PNG.
+      const outFormat: 'png' | 'jpeg' = outputSettings.format === 'png' ? 'png' : 'jpeg';
+      console.log(`⚡ Pipeline final step: Converting to ${outFormat} buffer`);
+      const processedBuffer = outFormat === 'png'
+        ? await processedImage.png({ compressionLevel: 3, adaptiveFiltering: false }).toBuffer()
+        : await processedImage.jpeg({ quality: 90 }).toBuffer();
```

**(2) `templateMaskFolderManager.ts:72–86`** — name from the encoder, keep the upload's basename.
New arg is **required**, not optional, so `tsc` catches any missed call site.

```diff
   static async saveProcessedImage(
     jobId: string, 
     imageIndex: number, 
     imageBuffer: Buffer, 
-    originalName: string
+    originalName: string,
+    outputFormat: 'png' | 'jpg'
   ): Promise<string> {
@@
-    // Create filename with index and original name
-    const extension = path.extname(originalName) || '.png';
-    const filename = `image_${String(imageIndex + 1).padStart(3, '0')}_${path.basename(originalName, extension)}${extension}`;
+    // Backlog 22 — the extension follows the *encoder*, not the upload. Before this,
+    // a JPEG-encoded photo.png was saved as `.png`. Basename still comes from the
+    // upload. Mirrors the video path's `ext` at videoProcessor.ts:516.
+    const extension = outputFormat === 'png' ? '.png' : '.jpg';
+    const filename = `image_${String(imageIndex + 1).padStart(3, '0')}_${path.basename(originalName, path.extname(originalName))}${extension}`;
```

`path.basename(name, '')` is safe for extensionless uploads — Node's `basename` ignores an empty
`ext` argument and returns the full name.

**(3) Both call sites** — one named local in `processImages`, beside the existing `outputSize` block:

```diff
+      // Extension follows the encoder, not the upload (backlog 22).
+      const outputExt: 'png' | 'jpg' = outputSettings.format === 'png' ? 'png' : 'jpg';
```
```diff
       await TempFolderManager.saveProcessedImage(
-        jobId, globalIndex, result.processedBuffer, originalName          // :865
+        jobId, globalIndex, result.processedBuffer, originalName, outputExt
       );
```
```diff
-      await TempFolderManager.saveProcessedImage(jobId, i, result.processedBuffer, originalName);        // :929
+      await TempFolderManager.saveProcessedImage(jobId, i, result.processedBuffer, originalName, outputExt);
```

**(4) `CLAUDE.md:636`** — item 22 → DONE, **rewritten** per §1 (both directions, one root cause),
stale `:1801` reference corrected.

**Out of scope, do not touch:** the video path, `shared/schema.ts`, `server/storage.ts`,
`server/pgStorage.ts`, `migrations/`. A3 stays frozen. `tsc --noEmit` must stay at 12.

---

## 4. Open decisions for the implementing agent

1. **Is the corrected scope still worth one deploy?** The backlog deferred this because it changes
   output bytes. The corrected finding *raises* the stakes: the mislabel is on the default path for
   every image job, not just the fallback. Reasonable read either way — this is the call to make
   before writing.

2. **Debug dump at `:2062–2067`.** `processFrame` writes `processedBuffer` to
   `output/debug_frame_0_processed.png`. After edit (1) that is JPEG bytes in a `.png` name — the
   same lie, in a dev-only artifact. Recon's recommendation: **leave it**, to keep the diff to the
   real path. Fixing it is one interpolated extension if the agent disagrees.

3. **Fallback-branch reachability.** `processFrame` is reached only from a `catch`. No evidence was
   gathered on whether that branch ever fires in prod. If it never has, edit (1) is dead-code
   hygiene and only (2)+(3) change real output. `grep -c "Fallback processed image" ` over the pm2
   logs on the box would settle it, and would also tell you whether any on-disk job has
   PNG-in-`.jpg` files versus JPEG-in-`.png`. Not blocking, but cheap.

4. **Old jobs are not migrated.** Explicitly decided by the backlog entry; recon concurs. Pre-fix
   files on disk keep their old names and stay viewable via `mimeForFrameFile`'s PNG fallback.

---

## 5. Verification plan

**Local** (per the toolchain note: no ffmpeg / no Postgres on this Mac, so `processImages` cannot be
run end to end — `storage.getVideoJob` blocks at module load without `DATABASE_URL`):

- `npx tsc --noEmit` → still exactly 12 errors
- Direct call on `saveProcessedImage`'s naming for 8 cases: upload ext `.jpg` / `.jpeg` / `.png` /
  none × `outputFormat` `png` / `jpg`

**On the box, after deploy** — upload a mixed 3-image batch (`.jpg`, `.jpeg`, `.png`), apply a mask:

```bash
file spokes/template_mask/<jobId>/*
```

Every reported type must match its extension. Run twice: default settings (expect `JPEG image data`
+ `.jpg` for all three) and PNG selected in the UI (expect `PNG image data` + `.png` for all three).
Then download the ZIP and confirm it opens.

**Expected behavior change:** default image output becomes JPEG bytes in `.jpg` files. For a
`.png` upload under default settings this is a *filename* change, not a bytes change — the bytes
were already JPEG. For the fallback branch it is a bytes change.

**Rollback:** single commit, `git revert`. No data implications.

---

## 6. Review + decision (2026-09-04)

**Verdict: proceed, with three amendments.** Independent re-verification against `main @ 21e588b`.

### 6.1 Recon's core correction is right, and I confirmed each claim

| Recon claim | Re-verified |
|---|---|
| `processFrame` (`:1848`) has exactly one caller — the `catch` fallback at `:923` | ✅ `grep "this.processFrame\b"` → `:923` only |
| `outputSettings` is in scope at `:2059` for edit (1) | ✅ destructured from `task` at `:1856`; type `OutputSettings` on the task at `:1852` |
| Image main path shares the already-fixed batch encoder | ✅ `:848 → processFrameBatch → :1786` |
| `saveProcessedImage` has exactly two call sites (`:865`, `:929`) | ✅ repo-wide grep, no other callers, no test fixtures assert the naming |
| Every reader is extension-agnostic | ✅ `listFrameFiles`/`countFrames`/`getProcessedImages` all `png\|jpe?g`; `mimeForFrameFile` derives from ext |

The premise correction matters: this is not a rare fallback-only bug, it is on the default path of
every image job, and `CLAUDE.md:636` must be **rewritten**, not struck through.

### 6.2 Amendment A — the mislabel is exported into the dataset ZIP (raises priority)

Recon stopped at the on-disk filename. It propagates one step further:

```
routes.ts:675   const fileExt = (filename) => filename.match(/\.(\w+)$/)?.[1] || 'png';
routes.ts:805   archive.file(framePath, { name: `images/frame_${paddedNum}.${ext}` });
```

The ZIP entry name is derived from the **on-disk** extension. So today a default-settings image job
exports `images/frame_000000.png` containing JPEG bytes — the lie ships inside the training-data
artifact, not just in a temp folder. That answers recon's open decision #1: **yes, worth one deploy.**
The fix propagates to the ZIP automatically (no extra code), but the verification plan must extend to
the export, which §5 does not currently cover:

```bash
unzip -o processed_<name>.zip -d /tmp/zipcheck && file /tmp/zipcheck/images/*
```

Every entry's reported type must match its extension, on both a default-settings run and a
PNG-selected run.

### 6.3 Amendment B — new finding, adjacent but OUT of scope for this commit

`manifest.json` / `metadata.csv` name frames `frame_0000.jpg` (`frameManifest.ts:72`,
`padStart(4)`, no folder prefix) while the ZIP actually contains `images/frame_000000.jpg`
(`routes.ts:803`, `padStart(6)`, under `images/`). **No filename in the manifest resolves to a file in
the archive** — a programmatic consumer loading by `manifest.frames[].filename` gets ENOENT on every
frame, and `metadata.csv`'s `filename` column has the same defect. README.txt calls manifest.json
"the primary AI output for programmatic use."

Pre-existing and longstanding (Phase 6 held the manifest byte-identical by design, D1), unrelated to
the encoder. **Do not fold it into item 22** — it changes manifest bytes and deserves its own gate.
Proposed new backlog entry for `CLAUDE.md`:

> **27. Manifest filenames don't resolve inside the export ZIP.** `buildPerFrameManifestAndCsv`
> emits `frame_%04d.<fmt>` (`frameManifest.ts:72`) while the ZIP writes `images/frame_%06d.<ext>`
> (`routes.ts:803`) — wrong zero-pad width and no `images/` prefix, in both `manifest.json` and
> `metadata.csv`. Affects both download paths (whole-job `:687`, per-run `:1815`). Changes manifest
> bytes, so it breaks the Phase 6 D1 byte-identical guarantee deliberately and needs its own commit.

### 6.4 Amendment C — the local verification is stronger than §5 implies

`templateMaskFolderManager.ts` imports only `fs`, `path`, and `cleanup.ts` (which imports no storage
and no `db`), so **`saveProcessedImage` is directly testable with no `DATABASE_URL` and no ffmpeg.**
Write it as `server/services/__tests__/saveProcessedImage.test.ts` using `node:test` + `npx tsx`,
matching the two existing test files (there is no test runner in `package.json`; `frameAccess.test.ts`
documents `npx tsx <file>` as the invocation). Cover the 8 cases §5 lists, write into an OS temp dir,
and assert the basename is preserved for `photo.tar.gz`-style names too.

### 6.5 Recon's open decisions — dispositions

1. **Worth one deploy?** Yes — see 6.2.
2. **Debug dump at `:2062`.** Agree, leave it. Note for the record: those `output/debug_frame_0_*`
   writes fire in production on the fallback path; dev cruft, separate cleanup, not this commit.
3. **Fallback reachability.** Do the grep (`pm2 logs masquerade --nostream --raw | grep -c "Fallback processed image"`),
   but it is not a gate — edits (2)+(3) are the real fix and stand either way.
4. **No migration of old jobs.** Agree.

### 6.6 Scope, frozen

Four edits exactly as recon §3 wrote them, plus the `CLAUDE.md` rewrite. Not in this commit: the
manifest mismatch (6.3), the debug dumps, the video path, `shared/schema.ts`, `storage.ts`,
`pgStorage.ts`, `migrations/`. `tsc --noEmit` stays at **12**.
