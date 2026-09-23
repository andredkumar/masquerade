# Output Round 1 — sign-off on the recon (2026-09-16)

**Input:** `OUTPUT_ROUND1_RECON.md`. **Decision:** approved — D1–D7 as recommended, with one scope addition (§2), two clarifications (§3), and the budget settled (§4). Build, `tsc` 12, A3 frozen, `buildApplyMask` untouched; stop after `OUTPUT_ROUND1_REPORT.md` for the runbook. Line references were re-checked against the tree.

## 1. D1–D7

| # | decision | taken |
|---|---|---|
| D1 | `output_transform` home | **Sidecar `spokes/template_mask/<jobId>/output_transform.json`**, as recommended. Considered and rejected: a key inside the `jobs.output_settings` jsonb (no schema change, outlives the 24 h sweep). Rejected because nothing needs the transform after the frames are gone — the ZIP carries it in the manifest — and mixing a *result* into a column named *settings* is the kind of thing A3 exists to stop. The sidecar is the `t0.json` / `automask.json` pattern; write it **after** the last frame and before the job is marked complete, so a download can never see frames without it. |
| D2 | CSV shape | Ten scalar columns, blank when null. Repeated per row is fine — pandas-friendly beats compact. |
| D3 | Keep toggle with no PNG | As recommended — and extended to Exclude, see §2. |
| D4 | viewer gate | `FrameViewer.tsx:247` → `size !== 'original'`, inside O1. |
| D5 | run download | `output_transform: null` unless `run.inputSource === 'template_mask'`. |
| D6 | budget | **2.5 days approved. O2 stays** — it is the one thing Andre asked for by name; cutting it to save half a day is the wrong trade. If anything gives, it is the private-method parity test (§7 of the recon): the structural argument plus the geometry rows exercising the batch path is enough. |
| D7 | `'stretch'` | As recommended — server union and `MaskData.aspectRatioMode` keep it, the `Select` and help copy lose it. Log one line per apply when a stale `'stretch'` arrives. |

## 2. Scope addition — O6: Apply after Clear / Erase All (recon §3, §8.6)

The recon filed this as pre-existing and out of scope. It comes in. After Clear, `maskData` is `{ type: 'rectangle', coordinates: [], opacity: 75 }` (`MaskingCanvas.tsx:198`), Apply is enabled because the gate is only `!maskData` (`template-mask-spoke.tsx:371`), and the coordinate fallback masks nothing — **a download of unmasked frames labelled as masked.** That is a de-identification failure in the product's core promise, the fix is the same line D3 already touches (`Clear` / `Erase All` → `setMaskData(null)`, Apply disabled until something is drawn), and it costs ~0.1 d. Fail-closed is the design rule; this is the one place the code is fail-open. Test row: Clear → Apply button disabled; Erase All → disabled; draw again → enabled.

## 3. Two clarifications for O1

1. **The trigger for centre-without-scaling is the string `size === 'original'`, not dimension equality.** The batch gate at `:1780-1782` compares dims and must change. A custom size that happens to equal the frame is a *scale* request (contain the keep into those dims — it upscales) and that is correct: only `'original'` means "don't resample". Say this in the UI copy for Original Size.
2. **The `632 × 1080` fallback** (`:1103-1104`) gets a `[PERF] apply.output {warn:'dims_fallback'}` line, not a fix. If it ever fires we want to know, and nothing more.

## 4. Notes for the build and the report

- The three bbox sites (`:476` video, `:1682` image fallback, `:1963` per-frame) share one `keepBbox(maskRgba, w, h)` — one function, three calls, one unit test (all-red → null, a known rect → its bounds, overhang → clipped).
- O3 removes all **three** debug writes (`:1877`, `:2081`, `:2093`) and the dead `outputDir` / `ensureOutputDir`.
- O4: the sized wrapper is `frameW·zoom/100 × frameH·zoom/100`, `transformOrigin: 'top left'`, `mx-auto`; `aside` + `shrink-0`; `main` + `min-w-0`; pane `overflow-auto`. `handleFitToScreen` still sets 100 % — leave it; a real fit-to-pane is a later item.
- Mixed-dimension image batches (recon §8.8): bbox from image 0, clipped per image; one sentence in the report's known limitations.
- Report headline: the geometry table (mode × size × clip: output dims, keep-centre error in px, padding asymmetry in px, no-resample row byte-equality, transform round-trip error) — numbers, not screenshots. Second: the O6 rows and the Keep/Exclude hash row.
- Facts the runbook needs: what changes in every download from this deploy on (crop-to-keep, `output_transform` in manifest + CSV, stretch gone), the O6 behaviour change (Apply disabled after Clear), and that jobs applied before the deploy have no sidecar → `output_transform: null` in their manifests, which is correct.

## 5. Invariants (unchanged)
`tsc` 12 (the same 12) · A3 frozen — `output_settings` written exactly as today · `buildApplyMask` `:628-672`, `createMaskRgbaBuffer`, `createTransformedMask`, the offsets loop, extraction, the reuse guard, `automask*.ts`, the worker untouched · `MaskingCanvas` export untouched except the O2 colour swap (`:1101-1102`, `:1123`, `:1129`) · no new dependencies · one commit, one `git revert` · nothing PHI-bearing committed (`output/` is not ignored — O3 stops writing there; the commit must not include it).

---
> `OUTPUT_ROUND1_SIGNOFF.md`: recon approved, D1–D7 as you recommended (sidecar; ten CSV columns; no-PNG = no mask; viewer gate; run download null unless template_mask; **2.5 d approved, O2 stays**, the parity private-method test is the cut if needed; stretch server-side only). One addition: **O6** — Apply after Clear / Erase All currently ships unmasked frames (`:198` + the `!maskData` gate); Clear and Erase All → `setMaskData(null)`, Apply disabled until something is drawn, in both toggle modes. Two clarifications: the no-scaling trigger is the string `'original'` (the batch dims-equality gate changes), and the 632 × 1080 fallback gets a warn line. Build Output Round 1 per `OUTPUT_ROUND1_RECON.md` + this sign-off, `tsc` 12, A3 frozen, `buildApplyMask` untouched, and stop after `OUTPUT_ROUND1_REPORT.md` for the runbook.
