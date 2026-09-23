# Output Round 1 — kickoff: crop to the cone, Keep/Exclude, and four fixes the 2B-2 session surfaced

**Status:** kickoff, 2026-09-12, against `main` @ `c909d36` (auto-mask 2B-2 deployed, `AUTOMASK_UI=1` on prod). **Executor:** Claude Code. **Step 1 is a short recon (§5, `file:line`) then stop for sign-off; step 2 builds and stops after `OUTPUT_ROUND1_REPORT.md` for the runbook.** No production code before sign-off. Not flag-gated (§4) — one commit, one `git revert`.

**Why this round:** the first thing Andre did after 2B-2 shipped was download a masked clip and find the cone sitting where the scanner had put it, with uneven black around it. That is an old bug, not a 2B-2 regression: every aspect-ratio mode resizes the **whole frame**, never the kept region. This round fixes the output pipeline and takes the four small items the 2B-2 session left behind. Three product decisions were taken by Andre on 2026-09-12 and are settled below (§1.1 original-size behaviour, §1.2 stretch removed, §2 one toggle per job).

## 1. O1 — every output mode crops to the keep first

**Today** (`videoProcessor.ts:2036-2063` per-frame; `:1756-1785` the batch/"3D" path; both end in `sharp.resize(w, h, { fit })`): `stretch` → `fill`, `letterbox` → `contain` + black, `crop` → `cover`, applied to the full `originalWidth × originalHeight` masked frame. The keep stays wherever it sat in the source frame; "letterbox" letterboxes the frame, not the cone.

**New pipeline, both paths, one shared function** (`outputTransform(bbox, frameW, frameH, settings)` returning the sharp steps; the two call sites become one-liners):

1. **Keep bounding box, once per job**, from the mask the apply already builds (the `maskRgba` that `:1977-1987` reads per pixel — keep = pixels the mask does not blank). Clipped to the frame. Computed in the apply setup, not per frame; passed into the frame task. `buildApplyMask` itself is not edited — the bbox is derived from its output.
2. `.extract({ left, top, width, height })` = the bbox.
3. Then the mode:

| mode | size = `original` | size = 224 / 256 / 416 / 512 / 1024 / custom |
|---|---|---|
| **Letterbox with Padding** | **Centre, no scaling:** composite the extracted keep onto a black `originalWidth × originalHeight` canvas, centred (`left = ⌊(W − w)/2⌋`, `top = ⌊(H − h)/2⌋`). No resampling — pixel scale is identical across a dataset (Andre's decision). | `.resize(w, h, { fit: 'contain', background: black, kernel: 'lanczos3' })` on the extracted keep — centred by sharp, symmetric padding. |
| **Centre Crop** | Identical to Letterbox at original size (the keep always fits its own frame; nothing to crop). Say so in the UI copy. | `.resize(w, h, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })` on the extracted keep. |
| ~~Stretch to Fit~~ | **Removed** from the UI (`ProcessingControls.tsx:235`) and from the type union's *offered* values. The server still accepts `'stretch'` from a stale client and treats it as `letterbox`, logged once per apply. | |

4. Encode as today (`:2065-2072`, JPEG q90 / PNG level 3 — unchanged).

**Edge rules.** Empty bbox (mask blanks everything) → fall back to the full frame, one `[PERF] apply.output {bbox:'empty'}` line, never a failed apply. A keep overhanging the frame (the E9 trapezoid, `w_bottom` 1245 on 1164) → bbox clipped to the frame, which is what the pixels are anyway. Image batches and DICOM single frames go through the same function.

**Traceability — required, not optional.** The crop changes the output's coordinate frame. `manifest.json` (and a column in `metadata.csv`) gains, per job: `output_transform: { mode, crop: {x, y, w, h} /* source-frame px */, scale: {x, y}, offset: {x, y} /* px in the output */, output: {w, h} }` so any label or `(0018,6011)` box can be mapped back to the original frame. README gets one sentence. The AI spoke runs on the cropped frames and its overlays are in the cropped frame — consistent — but the transform must be in the manifest for anyone going the other way.

**UI copy** (`ProcessingControls.tsx:224-225`) rewritten to describe the cone-level behaviour: "Letterbox: the kept region is centred with black padding; at Original Size it is centred without scaling." / "Centre Crop: the kept region fills the output; edges are cropped evenly."

## 2. O2 — Keep / Exclude toggle for hand-drawn masks

Today what you draw is what gets **blanked**: `updateMaskFromCanvas` (`MaskingCanvas.tsx:909-947`) fills the export canvas black and paints every object red; the server blanks red (`videoProcessor.ts:285`, `r > 150 && a > 128`). Andre wants the inverse available: draw the region to **keep**.

**Design — one toggle per job, default Exclude (today's behaviour), server untouched.** A **Keep / Exclude** switch in the masking tools panel (`MaskingTools.tsx`), state in the spoke, passed to `MaskingCanvas` as one prop. At export the two fills swap: Exclude = black canvas + red objects (today); Keep = **red canvas + black objects**. The PNG that leaves the browser is already in the server's convention; nothing server-side changes. The on-canvas recolour (`:66-72`, objects drawn red) is display-only and stays; the `_aiOverlay` preview (`:259-284`) shows the exported PNG and therefore shows the right thing in both modes.

**Interaction with the auto-mask (2B-2).** The proposal/accepted path already encodes keep-semantics as an evenodd path (outer rectangle + cone hole); under the Keep swap it would invert. **Rule:** while an `_automask` object is on the canvas (proposal or accepted), the toggle is locked to Exclude and shows why ("Auto-mask active"); after *Draw from scratch* it unlocks. Mixed drawings after Accept (2B-2 §10-E, strokes union with the cone) therefore stay Exclude — no new overlap rules.

**Recon must confirm** (§5.2) that every server path uses `canvasDataUrl` and never the type-specific `coordinates` (the `rect`/`circle`/`polygon` branches at `:971-1105` and the "fallback to old coordinate-based system" at `:1297`). If any path consumes coordinates, Keep mode forces `type: 'freeform'` so the PNG is the only truth.

Not persisted; not in the outcome line (it cannot be active when an automask session is).

## 3. O3–O5 — the leftovers

- **O3 — debug frame write.** `videoProcessor.ts:2078-2095` writes `output/debug_frame_0_processed.png` and `output/debug_frame_0_mask.png` on **every apply on prod** — a masked frame in a directory nothing sweeps. Remove. (Not gated behind an env var: nobody has read those files since Phase 4.)
- **O4 — sidebar collapse.** The canvas element's layout box is the full frame (`MaskingCanvas.tsx:235-238` `setDimensions`) and zoom is a CSS transform on the container (`:1276-1279`), which changes nothing in layout. On a 1440-px window a 1536-px clip overflows the `flex` row and the `aside w-80` (`template-mask-spoke.tsx:~330`) — with Apply in it — is pushed off or clipped. Fix: a wrapper sized to `frame × zoom/100` with `transform-origin: top left`, inside a `<main>` with `min-w-0 overflow-auto`, so the laid-out size equals the visual size and the sidebar keeps its 320 px. Recon names the exact elements; the fix is CSS/layout only — no change to pointer mapping (fabric reads the bounding rect, 2B-2 plan §2) and no change to the export.
- **O5 — outcome delta noise.** `d_half_angle_deg: 3.9e-14` on an untouched control (prod job `1e2e2425`). Round every delta to 2 decimals in `buildOutcome` (`useAutomaskProposal.ts`) before the POST; the zod schema is unchanged.

## 4. Not flag-gated — and why that is acceptable

O1 changes the geometry of every download from the moment it ships. It is a bug fix Andre asked for, there are no downstream consumers mapping today's outputs back to source coordinates, and the manifest transform makes the new outputs *more* traceable than the old. Rollback is one `git revert`; jobs applied under the new pipeline are ordinary masked frames. O2 defaults to today's behaviour. O3–O5 are strictly corrective. **If recon finds any stored job field that records output settings** (A3 is frozen — see §5.1), the answer is "read it, never write a new value", not a migration.

## 5. Recon (answer with `file:line`, then stop for sign-off)

1. **Where output settings live.** Confirm `OutputSettings` (`shared/schema.ts:216-227`) is per-request only and no `jobs` column stores `aspectRatioMode`; if one does, what reads it (A3 frozen — no column change).
2. **The two resize sites.** `:1756-1785` and `:2036-2063` — what else differs between them (kernel, the `outputSize` computation, `'original'` handling: `:2059` skips the resize on `original`, `:1778` compares dims), so one shared function replaces both without a behaviour split. Where `maskRgba` is built once per apply and where the bbox can be computed beside it (`:658`, `:1728`, `:1977`).
3. **Mask contract.** Every server consumer of `MaskData`: is `canvasDataUrl` the only input to `buildApplyMask`, or do `coordinates`/`type` matter anywhere (`:76-77`, `:136-137`, `:187-192`, and the `:1297` fallback)? This decides whether Keep mode must force `freeform`.
4. **Manifest builders.** `frameManifest.ts` (Phase 6's shared core) — where per-job fields go so `output_transform` lands in `manifest.json` and `metadata.csv` for both the template-mask download (`routes.ts:814-860`) and the AI-run download (`:1942-1967`) without two implementations.
5. **Sidebar.** The exact flex/overflow chain from `<main>` to the canvas container, and which element gets the sized wrapper.
6. **Test drivers.** Which §6 rows run unattended in the sandbox (`curl` + `run.ts`-style scoring), which need the Browser pane, which are Andre's.
7. **Effort** against ~2 days; cut order if over (O2 first — it is a feature; O1, O3, O4, O5 are fixes and stay).

## 6. Test matrix (runbook rows; sandbox unless marked)

| axis | rows |
|---|---|
| geometry | mode {letterbox, crop} × size {original, 256, 512, custom 640×480} × clip {reference MP4 1536×796 fan, E9 `.dcm` trapezoid (off-centre, overhanging), image batch}: output dims exactly the target (original → frame dims); keep-bbox centre within 1 px of the output centre; letterbox padding symmetric ±1 px; at original size **no resampling** — the extracted keep's pixels are byte-identical to the source region (compare a row); crop covers with no black; manifest `output_transform` round-trips a known point (e.g. the T0 box corner) from output → source within 1 px |
| parity | the per-frame path and the batch/3D path produce byte-identical output for the same frame + settings (hash) |
| edges | mask blanks everything → full-frame fallback + the `apply.output {bbox:'empty'}` line; `stretch` posted from a stale client → letterbox + one log line; overhanging keep clipped to the frame |
| co-indexing | AI spoke run on a cropped output → overlays line up (Round 2B U6 row, repeated) |
| Keep / Exclude | Exclude: byte-identical to today's PNG for the same drawing; Keep: draw one rectangle → output keeps only that rectangle; toggle locked with a proposal or accepted cone present, unlocked after Draw from scratch; `_aiOverlay` preview correct in both modes |
| O3 | `ls output/` unchanged across an apply |
| O4 (Mac) | 1440-px window, 1536-px clip at 75 %: sidebar visible, Apply reachable; at 150 % the canvas scrolls inside `<main>`; drag/draw still land where the pointer is at 50 / 150 (fabric pointer mapping unchanged) |
| O5 | untouched control → delta exactly `0`; nudged control → 2-decimal value |
| invariants | `tsc` 12; automask tests 6 + 4 + 2 + 13 + 5 green; `buildApplyMask`, extraction, the reuse guard, `automask*.ts`, `maskWorker.ts` untouched; `apply.done` on the reference clip within 10 % of 8.5 s (one `extract` added per frame) |

## 7. Constraints
`tsc` 12 (the same 12) · A3 frozen · `buildApplyMask`, extraction, reuse guard, `automask*.ts`, worker, `MaskingCanvas` export path except the O2 colour swap, untouched · no new dependencies · one commit, one `git revert` · nothing PHI-bearing committed (`uploads/`, `temp_extracted/`, `spokes/` are now ignored; `output/` is not — O3 stops writing there, and the commit must not include it).

## 8. Out of scope
Auto-mask 2C (template library B4, temporal support B6); the outcome pivot and grade thresholds (needs a week of real sessions); `.gitignore` duplicate lines (Andre's, next time he touches it); the retina export payload; the `fabric` package pin; frame-order in Finder (the ZIP is sorted and zero-padded — `routes.ts:846-853`; Finder was sorting by date).

---
> Continuing Masquerade (bring `CLAUDE.md`). 2B-2 is deployed (`c909d36`, `AUTOMASK_UI=1`). New round: **Output Round 1**, per `OUTPUT_ROUND1_KICKOFF.md` — every output mode crops to the keep's bounding box first (letterbox at Original Size = centre without scaling; stretch removed; `output_transform` in the manifest), a Keep/Exclude toggle for hand-drawn masks done as a colour swap at export with the server untouched, the debug frame write removed, the sidebar collapse fixed with a sized wrapper, outcome deltas rounded. Step 1 is recon §5 with `file:line` — the two resize sites, where the mask buffer is built, whether any server path reads mask `coordinates`, the manifest builder, the flex chain — then stop for my sign-off. `tsc` 12, A3 frozen, `buildApplyMask` untouched, no production code before sign-off.
