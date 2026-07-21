# Phase 6 Report — Manifest Unification + Base-Frame Toggle

Implements `PHASE_6_AMENDMENT.md` (§A manifest unification + §B base-frame toggle) on top of the ratified `PHASE_6_PROPOSAL.md`. Scope: backend `server/routes.ts` + new `server/handlers/frameManifest.ts` + one frontend control in `client/src/components/FrameViewer.tsx`.

## Design-note round-trip decision (§E)

**Proceeded directly to implementation — no separate design-note round-trip for §B.** The amendment left this to judgment (§B intro / §0). §B is fully specified against current source: the query-param shape, the `images/frame_%06d.<ext>` layout, the masked-first/raw-fallback resolver, and the toggle-independence of `frames[]` are all pinned down. Verification against live source (below) surfaced no ambiguity, so a round-trip would have added latency without resolving any open question. This report's §B sections are the promised inline design note.

## A. Shared-core extraction

New file: **`server/handlers/frameManifest.ts`**, exporting `buildPerFrameManifestAndCsv(input) → { frames, csv }` (shape (b)-lite, precedent `templateMaskApply.ts` from 3c).

- **Input:** `{ frameCount, labels, outputFormat }`. `labels` MUST be approval-filtered by the caller (D2 enforced in the wrappers, never in the core).
- **Moved into the core, verbatim:** `determineSplit` (80/10/10 by `i % 10`), `getLabelFrameConfidence` (`label.frameResults?.[i].confidence` → fallback `label.confidence ?? null`), the per-frame `frames[]` map, and the `metadata.csv` derivation (`ai_target`/`ai_confidence` = semicolon-joined label sets; headers `filename,frame_number,split,ai_target,ai_confidence`).
- **Kept in the whole-job handler:** `fileExt`, `slugifyTarget`, `labelsForManifest`, mask/overlay path resolvers, README — these are whole-job-only concerns (images/ archiving, analysis subfolders) and do not belong in the shared per-frame core.
- The two wrappers are **not** merged into one branchy function (per §A.1).

## Both wrappers

### Whole-job wrapper (`templateMaskDownloadHandler`, `routes.ts:530`)
- Frame set: `listFrameFiles(job.id)` (template-mask spoke) — unchanged.
- Labels: `job.aiLabels` filtered to `approved` — unchanged (`routes.ts:558`).
- Now calls the core with `{ frameCount: frameFiles.length, labels: approvedLabels, outputFormat }` and destructures `{ frames: manifestFrames, csv }`. The old inline `manifestFrames` map and the old inline CSV block were removed; local `determineSplit`/`getLabelFrameConfidence` were removed (now in the core).

### Run wrapper (`GET /api/jobs/:jobId/ai/runs/:runId/download`, `routes.ts:1724`-ish)
- Frame set (metadata): **enumerated from the run's own `mask_<i>.png` files** in `run.outputDir` — `frameCount = maskFiles.length` (§A.4). A `raw` run has an empty `template_mask` dir, so mask-file counting (not template-mask counting) is what correctly yields the frame count.
- Labels: `run.labels` (canonical) filtered to `approved` **in the wrapper** (`approvedRunLabels`) before calling the core (D2 by the caller).
- `frames[]` is **additive** to the run manifest (the pre-Phase-6 run manifest had no `frames[]`/CSV); `metadata.csv` is now appended to the run ZIP.
- `has_mask` is `true` for every run frame **by construction** — the frame set is derived from the mask files, so this now means the same thing on both paths (not merely a shared hardcode).
- `filename` is the field-compatible synthesized `frame_%04d.<outputFormat>` (nominal), matching the whole-job convention — deliberately **not** "fixed" to real ZIP paths (would break D1 field-compatibility). One parser for both ZIPs.
- Zero-approved-labels: frames still fully listed, each `ai_labels: []`; CSV = header + one row per frame with empty `ai_target`/`ai_confidence`.

## §A.2 / §D.1 — whole-job byte-identical confirmation

The core reproduces the whole-job output **exactly**:
- `Array.from({ length: frameFiles.length }, (_, i) => …)` yields the same indices `0..n-1` the old `frameFiles.map((filename, i) => …)` did — the `filename` param was unused (only `i`), so a count suffices.
- Per-frame object key order (`frame_number, filename, split, has_mask, ai_labels`) and per-label key order (`intent, target, modality, confidence, model, approved, bbox`) are preserved, so `JSON.stringify(manifest, null, 2)` is byte-for-byte the same.
- CSV headers, row shape (`"…"`-quoted target/confidence), and `\n` join are unchanged.
- Only `export_timestamp` (and `job_id` for a different job) varies — exactly the D1-allowed delta.

**§D.1 remains a stop-the-line gate for the operator:** capture `whole_job_manifest_BEFORE.json` + `metadata_BEFORE.csv` from the current prod build before deploy; after deploy, re-download the same job and diff. Any delta beyond `export_timestamp`/`job_id` → roll back.

## B. Base-frame toggle

### B.1 resolver (named against source)
Reused **`listFrameFiles` / `listRawFrameFiles` from `server/services/frameAccess.ts`** (already imported in `routes.ts:21-28`) — no new enumeration logic. `listFrameFiles(jobId)` reads the template-mask spoke; `listRawFrameFiles(jobId)` is pinned to `temp_extracted/<jobId>/`.

Resolution keys on **`run.inputSource`** (the recorded truth of what the run consumed), mirroring the Phase 4b-ii inference resolver at `routes.ts:871-875,911`:
- `run.inputSource === 'raw'` → `listRawFrameFiles` (temp_extracted).
- otherwise → `listFrameFiles` (template_mask), with `listRawFrameFiles` **fallback** if the masked dir is empty.

**Invariant satisfied:** the user always gets the frames the AI actually ran on. The UI tooltip states this ("the template-masked frames, or the raw frames when no template mask was applied — always the frames the run actually used").

### B.2 run ZIP folder layout (explicit)
When `includeBaseFrames=true`, the run ZIP contains, together:
- **`images/frame_%06d.<ext>`** — base frames, same naming convention as the whole-job builder (`ext` from each source file, 6-pad, sorted-position `i`).
- **`masks/mask_<i>.png`** — unchanged.
- **`overlays/overlay_<i>.png`** — unchanged.
- plus `manifest.json` + `metadata.csv`.

**No filename collision:** the three folders are distinct top-level prefixes (`images/`, `masks/`, `overlays/`); base frames use `frame_*`, masks use `mask_*`, overlays use `overlay_*`.

When the toggle is OFF (param absent or `false`): current behavior exactly — masks/overlays + `manifest.json` (now with `frames[]`) + `metadata.csv`, **no `images/`**.

### B.4 toggle-independence
`includeBaseFrames` gates **only** whether `images/` files are added. `frames[]` and `metadata.csv` (enumerated from `mask_<i>.png`) are emitted identically regardless of the toggle — the two concerns are not coupled in code.

### B.3 frontend control + URL param
Single authorized frontend change, in **`FrameViewer.tsx`**:
- New state `includeBaseFrames` (default `false`).
- New `Checkbox` ("Include base frames") in the footer beside "Continue to Download", using the already-imported shadcn `Checkbox` (`FrameViewer.tsx:4`, component at `client/src/components/ui/checkbox.tsx`) — matches the existing label-panel checkbox convention. `onCheckedChange={(checked) => setIncludeBaseFrames(checked === true)}` handles the `boolean | "indeterminate"` type cleanly.
- `handleContinueToDownload` now appends `?includeBaseFrames=true` to the run-download URL when checked; unchecked sends **no** param (back-compat). Still `window.open`, still one call per `distinctRunId`.

**Callsite change is deliberate:** the one run-download caller (`FrameViewer.tsx` `handleContinueToDownload`) now legitimately carries `?includeBaseFrames=…`. This is the sole run-download affordance; the whole-job download (`ProcessingStatus.tsx:93`) is untouched. No other download hits an unexpected endpoint.

## tsc

Ran `npx tsc --noEmit` before and after:
- **Before: 17** (10 `frameExtractor.ts` + 7 `maskWorker.ts`).
- **After: 17** — the error set is byte-for-byte identical (verified via `diff`). No new errors in `frameManifest.ts`, `routes.ts`, or `FrameViewer.tsx`. The frontend control introduced no type error (§B.3).

## Verification / smoke-test mapping (§D)

The operator runs, against a live build:
1. **D1 stop-the-line diff** (whole-job) — the load-bearing gate above.
2. **Toggle OFF** — URL has no `includeBaseFrames`; 200; ZIP = masks/overlays + manifest (with `frames[]`) + CSV, no `images/`.
3. **Toggle ON, template_mask run** — URL carries `includeBaseFrames=true`; ZIP has `images/` (from `template_mask`) + masks + overlays + manifest + CSV; `images/` naming = `frame_%06d.<ext>`.
4. **Toggle ON, RAW run** (the fallback path, most important new test) — `images/` populated from `temp_extracted/`; user still gets base frames (§B.1 invariant).
5. **Approved-only + zero-approved** run-download metadata checks (toggle-independent, §B.4).
6. **Live callsite sweep** — run-download row now carries `?includeBaseFrames=…`; confirm no other download affordance / unexpected endpoint.

## Observations (noticed-but-parked)

- **Item-15 temptation, resisted (hard fence, §C).** The §B raw-fallback makes the run download tolerant of a missing template mask. The parallel whole-job `templateMaskDownloadHandler` still `404`s when `template_mask` is empty (`routes.ts:552-554`) and was **not** given raw-fallback. This is the ratified, intentional temporary asymmetry — run download has raw-fallback for base frames; whole-job does not. Left parked, not "unified."
- **`filename` remains nominal on both paths.** The manifest `filename` is 4-pad `frame_%04d.<outputFormat>` while the real `images/` entries are 6-pad `frame_%06d.<ext>` (and `ext` may differ from `outputFormat`). Propagated knowingly per §A.5 / proposal Observation 1 — not "fixed," to preserve D1 field-compatibility.
- **`outputFormat` for the run** is sourced from `job.outputSettings?.format || 'png'` (same source as whole-job), keeping the synthesized `filename` field consistent across both ZIPs.
- **Run manifest top-level `labels[]` stays unfiltered** (unchanged pre-Phase-6 behavior); only the per-frame `frames[].ai_labels` and the CSV are approval-filtered (D2 applies to per-frame label data, not the run's label roster). Left as-is — outside Phase 6 scope.
- **Parked backlog untouched:** Socket.IO CORS `origin:"*"`, serve-static URIError guard, Express request-dump middleware, all 5B tails, and the Future-work parking lot.
