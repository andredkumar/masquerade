# Round 2C report — ffmpeg apply engine, behind `APPLY_ENGINE` (experiment)

**Spec:** `docs/refactor/ROUND2C_FFMPEG_APPLY_EXPERIMENT.md` · **Landed:** 2026-08-30. **NOT deployed.**
**Default is unchanged:** `APPLY_ENGINE` unset → `sharp` → today's deployed path.

**Gates:** `tsc` = **12**, same 12 · `npm run build` clean · `frameAccess.test.ts` **8/8** ·
`applyPaths.test.ts` **8/8** · A3 diff empty · `frameExtractor.ts` diff **empty** (extraction, the
DICOM branch and `extractAllFramesSequential` untouched) · **the sharp path is unchanged modulo
indentation** — `git diff -w` on `videoProcessor.ts` shows only two deleted lines, both declarations
hoisted out of the new branch (`const tempDir` / `let savedCount` → assignments).

**I could not run ffmpeg at all** — this box has no ffmpeg binary. What is verified here is the mask
geometry, the comparison harness, and the naming contract. The engine's speed and its output are for
the box. §4 is explicit about which is which.

---

## 1. Shape of the change

Two files, plus one script:

| file | what |
|---|---|
| `server/services/ffmpegApply.ts` | **new, self-contained** — engine resolution, bbox-mask writer, the ffmpeg invocation |
| `server/services/videoProcessor.ts` | one eligibility branch + one `if (ffmpegFrames !== null)` around the save path |
| `scripts/compare-apply-engines.ts` | **new** — the §3 pixel comparison the operator runs |

The engine lives in its own module deliberately: §5 pre-commits to deleting one of the two, and if
this is the loser, deletion is `rm server/services/ffmpegApply.ts` plus one branch — not archaeology.

`APPLY_ENGINE=ffmpeg` selects it; `APPLY_FFMPEG_QV` overrides `-q:v` (default `2`, clamped 1–31).
Both are reported on `apply.env` / `apply.engine`.

## 2. Eligibility — and what it logs when it declines

The engine runs only on: the **reuse** path, a **non-empty** prebuilt mask, **JPEG** output, **original**
size. Anything else routes to sharp exactly as today. When `APPLY_ENGINE=ffmpeg` is set but the job is
ineligible, `apply.engine` still fires with `{engine:'sharp', reason}` — `not_reuse_path`,
`no_prebuilt_mask`, `empty_mask`, `png_output`, `size_not_original` — so a run that silently used the
old engine is never mistaken for a measurement of the new one.

A throw, or an in≠out frame count, logs `{ok:false, error}` and falls back to sharp, which re-cleans
the output dir itself. **The experiment can never fail an apply.**

## 3. The masked-output naming contract — spec correction

> §2 of the experiment doc: "output `frame_%06d.jpg` 1-indexed"

**The deployed sharp path writes masked frames 0-indexed** — `frame_000000.jpg` … `frame_000347.jpg` —
because its save loop pads `frameNumber`, which starts at 0. Only the **raw** frames in
`temp_extracted/` are 1-indexed. I verified this on a real 67-frame run before writing the ffmpeg
output options.

This is not cosmetic. `frameAccess.resolveFramePath` builds a masked-frame filename **directly from the
index** (`frame_${String(n).padStart(6,'0')}.<ext>`), and it backs
`GET /api/jobs/:jobId/frames/:n.png`. A 1-indexed ffmpeg output would have **404'd frame 0 and served
every other frame off by one** — through a route the AI spoke uses, on a path where every frame count
and every co-indexing check still passes.

So the engine passes `-start_number 0` on the **output** (`-start_number 1` stays on the *input*, which
is correct — the raw sequence really is 1-indexed). Both engines now write identical filenames, which
is also what §3's comparison wants.

## 4. What was verified here, and what was not

### ✅ Verified locally

**Bbox mask alignment is exact.** The overlay is `buildApplyMask`'s output cropped to its bounding box
(the mask is not rebuilt or reinterpreted — §6). On a real 1054×802 frame with a prod-like 0.15 % mask,
bbox `44x29+80+54`:

```
2C overlay opaque=1276 vs offsets=1276  missing=0 extra=0   ALIGNMENT EXACT
```

Set equality between "overlay pixels with alpha > 0, offset by (x,y)" and "the prebuilt mask's offset
list". Zero missing, zero extra — the off-by-one in the overlay position is ruled out.

**The comparison script runs end to end and its thresholds compute.** Exercised against two real
output dirs (the sharp engine, and the same masked pixels re-encoded at a different JPEG quality as a
stand-in for encoder variance):

```
sharp  : 67 frames, 61.4 KB/frame mean
other  : 67 frames, 54.4 KB/frame mean
size ratio = 0.885   ADJUST APPLY_FFMPEG_QV — not within 10%
frame 1   masked max 0/0 PASS · interior max 0/0 PASS · unmasked mean=0.230 p99.9=7 max=19 PASS
=== §3 equivalence: PASS ===
```

The size-ratio gate correctly refuses a 12 % divergence, and the interior/masked/unmasked metrics all
compute against a real mask. Note this is *not* a test of ffmpeg's output — it is a test of the
measuring instrument.

### ⚠️ NOT verified — no ffmpeg on this box

| claim | status |
|---|---|
| the ffmpeg command runs at all | **untested** |
| `overlay=x:y:format=auto` composites correctly over rgb24 input | **untested** |
| in == out frame count (348 → 348) | **untested** |
| `-q:v 2` lands within 10 % of sharp's ~80 KB/frame | **untested — calibrate on the box** |
| mjpeg chroma is `yuvj420p`, matching sharp's 4:2:0 | **untested — read it off the ffmpeg banner** |
| 8.7 s → 3–4 s, i.e. the ≥ 1.5× bar | **untested** |

The §3 equivalence numbers in this report come from a *simulated* second encoder, not from ffmpeg.
Nothing here is evidence that the engine wins.

## 5. Running the experiment on the box

Per §4 of the spec, with one addition — **copy the output dir aside between the two applies**, since
the second apply wipes it:

```bash
# 1. baseline (default engine)
#    apply once, note apply.done, then:
cp -r spokes/template_mask/<jobId> /tmp/2c_sharp

# 2. switch engines
APPLY_ENGINE=ffmpeg pm2 restart masquerade --update-env
#    confirm:  [PERF] {"stage":"apply.env", ... "apply_engine":"ffmpeg"}

# 3. redo apply on the SAME job (reuse path, same frames, same mask), then:
cp -r spokes/template_mask/<jobId> /tmp/2c_ffmpeg
```

The `apply.engine` line carries everything the comparison needs:
`{"engine":"ffmpeg","frames":348,"qv":"2","bbox":"WxH+X+Y","mask_path":"/tmp/masq_mask_bbox_<jobId>.png"}`.
The overlay PNG is deliberately **left in `/tmp`** for this step.

```bash
npx tsx scripts/compare-apply-engines.ts \
  --sharp /tmp/2c_sharp --ffmpeg /tmp/2c_ffmpeg \
  --mask /tmp/masq_mask_bbox_<jobId>.png --bbox <X>,<Y> \
  --frames 1,174,348
```

**Calibrate before timing.** If the script's size ratio is outside ±10 %, re-run step 2–3 with
`APPLY_FFMPEG_QV=<n>` (lower = larger files) until it is inside, *then* compare `apply.done`. A speed
number taken at a different output size is not a speed number.

Then: DICOM multiframe with `APPLY_ENGINE=ffmpeg` (its raw frames are PNGs in `temp_extracted/` too,
so it takes the same path), an AI run on the ffmpeg output, and a ZIP download.

## 6. The decision, restated

§5 is pre-committed and this report does not soften it:

- **≥ 1.5× faster on prod AND §3 passes** → ffmpeg becomes the default; resize/PNG support is a
  follow-up; the sharp mask loop is deleted once that lands.
- **Otherwise** → `rm server/services/ffmpegApply.ts`, drop the branch in `processVideo`, drop
  `scripts/compare-apply-engines.ts`. Not "keep it behind the flag."

If it is adopted, §3's tolerance becomes the standing definition of the masked-output contract:
**masked pixels ≤ 8 after decode with the box interior exactly 0; unmasked pixels equal within JPEG
encoder variance (mean ≤ 2.0, p99.9 ≤ 16, max ≤ 32) — not byte-identical.** Recording that here so it
is not rediscovered as a bug later.
