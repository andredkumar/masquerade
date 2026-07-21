# Phase 6 — Pre-Deploy Clarification Addendum

Answers to `PHASE_6_PREDEPLOY_CLARIFICATION.md`, source-level, current line refs. **No code changes were required** (Q1 is provably 1:1/co-indexed for the reachable set; Q2/Q3 are already the current behavior). `tsc` re-confirmed **17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`), unchanged.

Line numbers below are post-Phase-6 (the §A edits shifted the inference handler up ~30 lines from the numbers the report quoted).

---

## Q1 — the two enumerations are 1:1 and co-indexed (no code change)

The run wrapper uses two enumerations:
- `frames[]` metadata count = `maskFiles.length` (`mask_*.png` in `run.outputDir`), §A.4.
- `images/` payload = base-frame resolver (`listFrameFiles` / `listRawFrameFiles`), §B.1.

### Q1.1 — count: one mask per base frame, by construction

The inference loop writes **exactly one `mask_<i>.png` per base frame**, unconditionally, iterating the resolver's own list:

- **Raw run** (`routes.ts:916-943`): `for (let i = 0; i < rawFrameFileNames.length; i++)` over `listRawFrameFiles(jobId).files`; `mask_${i}.png` write is unconditional at `routes.ts:937` (`writes.push(...writeFile(mask_${i}.png...))` — always pushed; only the *overlay* write at `:938` is conditional on `r.overlayBase64`).
- **Masked run** (`routes.ts:944-972`): `for (let i = 0; i < frameFileNames.length; i++)` over `listFrameFiles(jobId).files`; unconditional `mask_${i}.png` write at `routes.ts:966`.
- **Single-frame fallback** (`routes.ts:897-915`): writes `mask_0.png` (`:911`) — no base frames exist on disk (input was `frameBase64` from the request body), so `includeBaseFrames` resolves to an empty list; not a divergence (see Q3).

So for a run that completed inference, `maskFiles.length` == the length of the resolver list it iterated. And for a given job, `template_mask/<jobId>/` and `temp_extracted/<jobId>/` hold the same frame count E (template masking is a 1:1 per-frame transform of the extracted frames), so the masked-first/raw-fallback resolver returns E on either branch. Therefore **`maskFiles.length` == base-frame count** in every completed, unswept state.

### Q1.2 — ordering: same function, same list, same index `i`

`listRawFrameFiles` is literally `listFrameFiles(jobId, TEMP_EXTRACTED_DIR)` (`frameAccess.ts:160-164`); both return `Array.from(new Set(filtered)).sort()` (`frameAccess.ts:136`) — deterministic dedupe + sort. Inference and the download resolver call the **same function on the same job directory**, so they produce the **identical `files` array**. The inference loop wrote `mask_${i}.png` for the i-th element of that array; the download serves `images/frame_%06d(i)` for the i-th element of the same array; the core emits `frames[].frame_number = i`. All three key to the same sorted position `i`. **Ordering cannot diverge** — this holds regardless of the sort being lexical, because it is the same sort on the same input by construction.

(The lexical `.sort()` of `maskFiles` in the download handler — `mask_0, mask_1, mask_10, mask_2, …` — is irrelevant: the wrapper uses only `maskFiles.length`, never `maskFiles` order. `frames[].frame_number` is generated numerically `0..N-1` by the core, not read from the mask filenames.)

### Recorded invariant

> For a completed run, `frames[].frame_number == i`, `mask_<i>.png`, `overlay_<i>.png`, and `images/frame_%06d(i)` all denote the same base-frame sorted-position `i` — because inference wrote `mask_<i>` while iterating the exact `listFrameFiles`/`listRawFrameFiles` array the download resolver re-reads, and that array is deterministic (same function, same dir). One mask is written per base frame unconditionally, so the counts are equal.

### The two theoretical divergence windows (both outside the reachable/supported set)

1. **Inference aborted mid-loop.** If `aiClient.infer` throws on frame k, the handler's `try/catch` returns 500 (`routes.ts:1017-1021`) and the loop stops with masks `0..k-1` on disk. But the label is written **after** the loop (`storage.updateAiRun(..., { labels: [newLabel] })` at `routes.ts:997`), so such a run has `labels: []`. The FrameViewer's `distinctRunIds` collects run ids only from labels present in `inference.json` frames, so a label-less partial run **never appears in the download UI** (`FrameViewer.tsx` `distinctRunIds`/`handleContinueToDownload`). It is reachable only by hand-crafting the API URL, and it is already a degenerate error-state run (a *failed* inference), pre-existing and out of Phase 6's scope (run lifecycle, not manifest unification). Even then co-indexing holds for the shared positions `0..k-1`; at worst `images/` carries trailing frames `k..N-1` with no `frames[]` row — no frame is ever *mislabeled*.
2. **Partial mid-life mutation of the base-frame dir** between inference and download. The 24h retention sweep removes **whole** job dirs, not individual frames, so it cannot produce a partial count. A full sweep yields Q3 (empty resolver → `images/` omitted), not a mismatch.

Because the reachable, supported behavior is provably 1:1 and co-indexed, and §A.4 (source `frames[]` from mask files) is frozen, **no code change is made.** Re-keying `frames[]` to the resolver, or clamping `images/` to `maskFiles.length`, would either change the ratified §A.4 sourcing or drop base frames the AI ran on (violating §B.1) — both are out of the "no scope change" bound and neither is needed for the reachable set.

---

## Q2 — the non-raw "masked-empty → raw fallback" branch is deliberate

Confirmed intentional. Resolution logic (`routes.ts:1777-1794`):
- `run.inputSource === 'raw'` → `listRawFrameFiles`.
- otherwise → `listFrameFiles`; **only if** `masked.files.length === 0` → `listRawFrameFiles`.

**Case it protects:** a run that originally used template masking whose `template_mask/<jobId>/` dir has been swept (24h retention) while `temp_extracted/<jobId>/` is still present — the user still receives the run's base frames rather than an empty `images/`. It also makes the download resolver mirror the robustness of the inference resolver.

**It cannot mis-resolve a genuine template-mask run to raw while the masked dir is present:** the fallback is gated on `masked.files.length === 0`. If the template-mask dir has any frames, the masked branch is taken; the raw branch is unreachable. So an intact template-mask run always serves masked base frames.

**Noted semantic nuance (already blessed by the amendment):** when the fallback *does* fire for a template-mask run, the served `images/` are the *raw* originals, not the masked frames the AI saw. This is exactly the amendment's stated behavior — "the toggle label may say 'template mask frames,' but the fallback guarantees they get *the run's* base frames regardless of input source" (§B.1) — and the UI tooltip already states it. Count/co-indexing are unaffected (E == E, same sorted positions).

---

## Q3 — resolver returns empty (both dirs swept): omit `images/`, keep the rest

**Current behavior (confirmed, `routes.ts:1777-1802`):** when `includeBaseFrames=true` but the resolver returns `files: []` (raw branch empty, or masked empty → raw fallback also empty), the `for` loop at `:1797` iterates zero times, so **no `images/` entries are appended**. The masks, overlays, `manifest.json`, and `metadata.csv` are added earlier (`:1762-1774`) from `run.outputDir`, which is independent of the base-frame dirs and may well still exist.

**Recommendation: keep this — silent omission of `images/`, everything else returned.** Rationale: the masks/overlays live in `run.outputDir` (a different lifecycle from the base-frame source dirs), so a 410/hard-error would needlessly deny the user artifacts that are still on disk. The base-frame payload is an *optional add-on*; its unavailability should degrade gracefully, not fail the whole download. This differs deliberately from the FrameViewer's 410-on-expiry, which gates the *primary* artifact (the frames themselves), not an optional add-on.

No code change (this is already the behavior). A manifest flag advertising "base frames requested but unavailable" was considered and **rejected as scope creep** — the manifest carries no `includeBaseFrames` field today, and adding one is outside this clarification's "no new features" bound.

---

## tsc

No source changed for this clarification. `npx tsc --noEmit` re-run from `masquerade-aws-latest/`: **17** errors, all in `frameExtractor.ts` (10) + `maskWorker.ts` (7) — identical to the Phase 6 before/after baseline.
