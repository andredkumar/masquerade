# Phase 6 Proposal — Manifest Builder Unification

**Status:** Proposal only. No production code written in this session (hard constraint).
**Source of truth for all line numbers below:** `server/routes.ts` as read on 2026-07-21
(1855 lines). The kickoff's line numbers were stale; the current ones are given here.
**tsc baseline:** 17 (10 `frameExtractor.ts` + 7 `maskWorker.ts`) — unchanged by this
read-only session; any implementation must hold it at exactly 17.

---

## 0. TL;DR

- Both builders re-located and read in full. The whole-job builder **does** filter
  per-frame label data to approved (line 558) — **D2 holds, nothing to flag on that front.**
- Exactly **two** download affordances exist in the entire client, each hitting exactly one
  builder. Both are direct `window.open` string templates — no react-query queryKey-array
  or base-path indirection hides a third caller (the 4d-1b class is checked and clean; see §2).
- The two builders share exactly **one** piece of logic: the per-frame `frames[]` assembly and
  the CSV derivation. That shared piece is the piece that drifted. Everything else (label scope,
  frame source, wrapper metadata, ZIP payload) genuinely diverges.
- **Recommendation: (b)-lite** — extract only the per-frame `frames[]` + CSV core into one shared
  function; each endpoint keeps a thin wrapper that decides which frames/labels to feed it and
  what job-level or run-level metadata wraps the result. Backend-only. No frontend change.
- Three open questions for the operator survive the source read (§6) — all about run-download
  frame-source and filename semantics, not about whether to proceed.

---

## 1. Source confirmation of both builders

### 1.1 Frame-by-frame / whole-job builder — `templateMaskDownloadHandler`

- **Definition:** `server/routes.ts:530–808` (the `const templateMaskDownloadHandler` arrow).
- **Registration (the ONLY one):** `server/routes.ts:809`
  `app.get("/api/jobs/:jobId/template-mask/download", templateMaskDownloadHandler)`.
  A grep of the whole file for the handler name and for `template-mask/download` returns this
  single registration — the builder serves exactly one endpoint.
- **Client caller (the ONLY one):** `client/src/components/ProcessingStatus.tsx:93`
  `window.open(`/api/jobs/${jobId}/template-mask/download`, '_blank')`, triggered by the
  "Download" button (`ProcessingStatus.tsx:227`, `handleDownload` at `:92`). `ProcessingStatus`
  is rendered in exactly one place: `client/src/pages/template-mask-spoke.tsx:257`.

**Handler flow:**

1. `storage.getVideoJob(jobId)` → 404 if missing (`:532–535`). **Reads the legacy `VideoJob`
   derivation.**
2. Gate: `job.status !== 'completed'` → 400 (`:537–541`). (This is the legacy 6-value
   `video_status`, not the V2 `job_status`.)
3. Optional query flags `masks === 'true'`, `overlays === 'true'` (`:544–545`). **No client sets
   these** (grep: zero hits for `masks=true`/`overlays=true` in `client/src`), so in practice the
   ZIP is images + manifest + README + CSV only; mask/overlay inclusion is a manual-URL path.
4. Frames enumerated via `listFrameFiles(job.id)` (`:551`) → defaults to
   `SPOKE_TEMPLATE_MASK_DIR` = `spokes/template_mask/<jobId>/`, `.png|.jpe?g` filtered, deduped,
   **sorted**. 404 if empty (`:552–554`).
5. Labels: `((job as any).aiLabels || [])` filtered to `l.approved` (`:557–558`).
   **This is the approved-only filter — D2 confirmed for the whole-job builder.**
6. `labelRunDirMap` built from `storage.listAiRuns(job.id)` (`:569–573`) to resolve each label's
   on-disk mask/overlay dir (`spokes/ai/<jobId>/<runId>/`).

**Manifest field list (`:656–666`) and sourcing:**

| Field | Source |
|---|---|
| `masquerade_version` | literal `'1.0'` |
| `export_timestamp` | `new Date().toISOString()` |
| `job_id` | `job.id` |
| `source_filename` | `job.filename` |
| `total_frames` | `frameFiles.length` (template_mask count) |
| `output_format` | `job.outputSettings?.format || 'png'` |
| `splits` | literal `{ train: 0.8, val: 0.1, test: 0.1 }` |
| `ai_labels[]` (top-level) | approved labels → `{ id, intent, target, modality, confidence, model, approved, bbox }` (`:604–613`) |
| `frames[]` | `manifestFrames` (per-frame array, `:633–654`) |

**Per-frame object (`manifestFrames`, `:647–653`):**
`frame_number: i` (sorted position), `filename: `frame_${String(i).padStart(4,'0')}.${outputFormat}``,
`split: determineSplit(i)` (80/10/10 by `i % 10`, `:618–623`), `has_mask: true` (**hardcoded**),
`ai_labels: perFrameLabels`. Each per-frame label (`:638–646`):
`{ intent, target, modality, confidence, model, approved, bbox }` where `confidence` is
**this frame's** score via `getLabelFrameConfidence(l, i)` = `label.frameResults?.[i].confidence`
falling back to `label.confidence` (`:587–591`).

**CSV (`metadata.csv`, `:725–732`):** headers
`['filename','frame_number','split','ai_target','ai_confidence']`; one row per `manifestFrames`
entry. `ai_target` and `ai_confidence` are **job-level aggregates** — all approved labels'
targets/confidences semicolon-joined (`:726–727`) — so those two columns are **identical on
every row**. `filename` cell = `manifestFrames.filename` (the 4-pad form).

**Also emitted:** `README.txt` (`:713–723`, with per-run subfolder docs gated on `hasAnyMasks`/
`hasAnyOverlays`).

**ZIP payload (`:751–795`):** `manifest.json`, `README.txt`, `metadata.csv`, then
`images/frame_${String(i).padStart(6,'0')}.${ext}` per frame (**6-pad**, `ext` from the real
source filename via `fileExt`, `:627–630`), plus — only when the query flags are set — per-label
subfolders `masks/analysis_N_<slug>/frame_%06d_mask.png` and
`overlays/analysis_N_<slug>/frame_%06d_overlay.png`. archiver `zlib level 9`.

**Frame keying:** sorted-list position `i` is the canonical frame number everywhere (manifest,
CSV, images/, mask/overlay lookup). Matches the inference loop's keying. Confirmed.

**Masked-vs-raw fallback:** none in this builder. It reads `template_mask` only and 404s if empty
(`:552–554`) — the backlog-item-15 asymmetry. **Out of scope; not touched.**

### 1.2 Run-scoped builder — inline handler

- **Definition + registration (the ONLY one):** `server/routes.ts:1724–1799`
  `app.get("/api/jobs/:jobId/ai/runs/:runId/download", async (req, res) => {…})`. Inline, no
  named handler const.
- **Client caller (the ONLY one):** `client/src/components/FrameViewer.tsx:317`
  `window.open(`/api/jobs/${jobId}/ai/runs/${runId}/download`, '_blank')`, inside
  `handleContinueToDownload` (`:315–320`). It iterates `distinctRunIds` (`:304–313`) — the set of
  `runId`s collected from **every** label in `inferenceData.frames` (approval-agnostic; see §1.3).
  `FrameViewer` is rendered in exactly one place: `client/src/pages/ai-spoke.tsx:320`.

**Handler flow:**

1. `storage.getVideoJob(jobId)` → 404 (`:1726–1727`).
2. `storage.getAiRun(jobId, runId)` → 404 (`:1729–1730`). **Reads the canonical `AIRun`.**
3. `fs.existsSync(run.outputDir)` → 404 (`:1733–1734`).
4. `fs.readdirSync(run.outputDir)` filtered `.png|.jpe?g`, **sorted** (`:1737`); 404 if empty
   (`:1738–1739`). Split into `maskFiles` (`mask_` prefix) and `overlayFiles` (`overlay_` prefix)
   (`:1742–1743`).

**Manifest field list (`:1746–1763`):**

| Field | Source |
|---|---|
| `jobId` | `req.params.jobId` |
| `runId` | `run.id` |
| `runName` | `run.name` |
| `target` | `run.target` |
| `modality` | `run.modality || null` |
| `inputSource` | `run.inputSource` (`extracted`/`template_mask`/`raw`) |
| `createdAt` | `run.createdAt` |
| `labels[]` | `run.labels.map → { id, target, approved, confidence, model }` — **unfiltered by approval** |
| `maskCount` | `maskFiles.length` |
| `overlayCount` | `overlayFiles.length` |

**No `frames[]`, no CSV, no README.** ZIP payload (`:1778–1789`): `masks/<file>` per mask,
`overlays/<file>` per overlay, `manifest.json`. **No base-frame `images/`.** archiver
`zlib level 1`.

**Label sourcing:** `run.labels` — the **canonical** shape. Per the 1:1 run↔label invariant
(`aiInferHandler` writes `storage.updateAiRun(jobId, runId, { labels: [newLabel] })` at
`routes.ts:1031`), a run has **exactly one** label, created `approved: true` by default
(`:1024`) and toggled only via the PATCH label endpoint.

**Frame keying:** the run's artifacts are `mask_<i>.png` / `overlay_<i>.png` where `i` is the
same sorted-list position the inference loop wrote with (`routes.ts:1000–1004` for masked,
`:971–975` for raw). The run's `label.frameResults` is keyed by the same `i`. So both builders
agree on the sorted-position convention.

**Masked-vs-raw fallback:** the run download reads `run.outputDir` directly, so it is
*independent* of whether a template mask was applied — a `raw`-inputSource run's artifacts are
present regardless. (This is the reason the run's frame set should come from its own artifacts,
not from `template_mask`; see §3 and §4.)

### 1.3 Label sourcing: legacy vs canonical, and a consolidation note

- Whole-job builder consumes **`job.aiLabels`** (legacy derived shape) for label metadata
  (`:557`), plus `listAiRuns` only to resolve on-disk dirs (`:569`).
- Run builder consumes **`run.labels`** (canonical) (`:1754`).
- Both are A3 derivations of the same rows. For the (b)-lite shared core, **the run path can and
  should stay fully canonical** (`run.labels`, approval-filtered) — it already has the label with
  `frameResults` in hand, so it never needs to touch `job.aiLabels`. The whole-job path stays on
  `job.aiLabels` as-is (changing it is unnecessary and risks D1). **This is a read-path choice
  inside the builders only — it licenses no change to `pgStorage.ts`, the schema, or the
  derivation shim (all frozen).**

---

## 2. Callsite map — static AND live-verification plan

### 2.1 Static trace (complete)

Every construction of either download URL in `client/src`, dynamic forms included:

| # | URL built | File:line | Component | User action |
|---|---|---|---|---|
| 1 | `/api/jobs/${jobId}/template-mask/download` | `ProcessingStatus.tsx:93` | `ProcessingStatus` (rendered at `template-mask-spoke.tsx:257`) | Clicks **Download** button on the Template-Mask spoke after masking completes |
| 2 | `/api/jobs/${jobId}/ai/runs/${runId}/download` | `FrameViewer.tsx:317` | `FrameViewer` (rendered at `ai-spoke.tsx:320`) | Clicks **Continue to Download** in the frame viewer; fires once per distinct `runId` |

**Dynamic-construction due diligence (the binding 4d-1b lesson):**

- Both callers use a **direct `window.open` template literal**, not react-query. Downloads are
  browser navigations, not fetches, so they never pass through `queryClient`'s
  `queryKey.join("/")` fetcher (`client/src/lib/queryClient.ts:54`). There is therefore no
  queryKey-array form of either download URL to miss.
- Greps run and confirmed clean: `window.open` / `createElement('a')` / `.href =` in `client/src`
  → only the two rows above. `masks=true` / `overlays=true` / `.zip` / `includeMasks` /
  `includeOverlays` → **zero** download-related hits. No `API_BASE` / `BASE_URL` / `apiUrl(`
  base-path concatenation helper exists in `client/src`. `/download` does not appear anywhere in
  `client/src/lib`.
- **Conclusion:** builder 1.1 serves exactly one caller; builder 1.2 serves exactly one caller.
  Blast radius is one caller each. Still, per the lesson, the static result is **necessary but
  not sufficient** — the operator must confirm with the live check below before the change is
  trusted.

**Note on the run caller's runId set:** `FrameViewer`'s `distinctRunIds` is built from
`inference.json`'s `frames`, and `inference.json` lists **all** labels regardless of approval
(`routes.ts:1406` iterates `allLabels`, not approved-only). So "Continue to Download" will
trigger a run download even for a run whose sole label is currently unapproved. This is relevant
to the zero-approved behavior in §4 — it is reachable from the UI.

### 2.2 Live-verification plan (operator, copy-paste + screenshot)

You cannot rely on the static grep alone. Run this on the deployed stack **after** the Phase 6
implementation deploys. Do it on a **fresh browser session** (new incognito window) so nothing is
cached.

**Setup**
1. Open Chrome incognito. Open DevTools (`Cmd+Option+I`), click the **Network** tab, check
   **Preserve log**, and leave it open for every step below.
2. Upload a short test video on `/upload`, attest "No PHI", and wait for the hub to show the job
   as ready.

**Path A — Template-Mask spoke download**
3. Open the **Template Mask** spoke, apply a mask, and wait for completion.
4. Click the **Download** button. In the Network tab, find the request row and screenshot it.
   **Confirm the Request URL is exactly** `…/api/jobs/<jobId>/template-mask/download` and Status
   is `200`. Open the downloaded ZIP; screenshot its file listing (should include `manifest.json`,
   `README.txt`, `metadata.csv`, `images/`).

**Path B — AI spoke "Continue to Download"**
5. Open the **Run AI Models** spoke, run one inference, open the frame viewer, click
   **Continue to Download**. In the Network tab, screenshot every request the click produced.
   **Confirm each Request URL is exactly** `…/api/jobs/<jobId>/ai/runs/<runId>/download` and
   Status is `200`. Note how many fired (should be one per distinct run).

**Sweep — every other download affordance**
6. Walk the whole app and click **every** button/link that could download: the hub page, any
   "Download all" you find, the template-mask spoke, the AI spoke, the frame viewer. For each,
   screenshot the Network row and record which endpoint it hit. If **any** download hits an
   endpoint other than the two above, stop and report it — the blast-radius assumption is wrong.

**Report:** paste the screenshots and, for each affordance, one line: *"button X → `URL` →
status N"*.

---

## 3. Overlap analysis and recommendation

### 3.1 Quantified overlap

**Shared logic (the drift locus):**

- Per-frame `frames[]` assembly: `frame_number`, `filename`, `split`, `has_mask`,
  `ai_labels[]` with **per-frame** confidence (`routes.ts:633–654`, ~22 lines incl. the
  `determineSplit`/`getLabelFrameConfidence` helpers it leans on).
- CSV derivation from that same per-frame array (`:725–732`, ~8 lines).

That is the **entire** overlap. The run builder has none of it today — this is exactly the code
that exists in one builder and not the other, i.e. the drift that caused the bug.

**Genuinely divergent logic (must NOT be forced into one branchy function):**

| Concern | Whole-job (1.1) | Run-scoped (1.2) |
|---|---|---|
| Label scope | all approved labels across the job | the run's single label |
| Label source | `job.aiLabels` (legacy) | `run.labels` (canonical) |
| Frame source | `template_mask/<jobId>/` file list | `run.outputDir` mask files |
| Wrapper metadata | job-level (`masquerade_version`, `source_filename`, `splits`, `output_format`, top-level `ai_labels[]`) | run-level (`runId`, `runName`, `target`, `inputSource`, `createdAt`, `maskCount`, `overlayCount`, `labels[]`) |
| Base frames in ZIP | `images/frame_%06d.<ext>` included | not included (masks/overlays only) |
| CSV `ai_target`/`ai_confidence` | aggregate of all approved labels | the run's one label |
| archiver level | 9 | 1 |

Roughly ~30 shared lines vs. two substantially different ~40-line wrappers. Full unification (b)
would need `if (mode === 'run')` branching across the frame source, label source, and the entire
metadata wrapper — "two builders in a trenchcoat." Rejected.

### 3.2 Recommendation: (b)-lite

**Extract only the per-frame `frames[]` + CSV core into one shared function.** Each endpoint keeps
a thin wrapper that (1) picks the frame set, (2) picks and approval-filters the label set,
(3) calls the shared core, (4) wraps the result in its own job-level or run-level metadata and
appends `metadata.csv` to its ZIP.

**Why (b)-lite over (a) and (b):**

- vs **(a) Port:** (a) copies the ~30 shared lines into the run builder, leaving two copies —
  the exact condition that produced this bug (the two paths drifted). (b)-lite deletes the
  duplication instead of doubling it.
- vs **(b) Full unification:** the wrappers are genuinely different (table above). Merging them
  forces mode-branching that is harder to read and more bug-prone than two thin wrappers over one
  shared core.
- (b)-lite isolates the shared piece to *exactly* the piece that drifted, and nothing else.

**Blast-radius analysis:**

- **Whole-job caller (`ProcessingStatus` → `template-mask/download`):** must observe **nothing**
  (D1). Achieved by lifting the *current* `manifestFrames`/CSV code into the shared function
  verbatim and having the whole-job wrapper feed it the same inputs, so its `frames[]` and
  `metadata.csv` are **byte-identical**. Verified by the before/after diff in §5.
- **Run caller (`FrameViewer` → `ai/runs/:runId/download`):** the run ZIP **gains** `frames[]`
  inside `manifest.json` and a new `metadata.csv`. All existing run-manifest fields
  (`:1746–1763`) keep their names/types/semantics (**D1 additive-only**); the mask/overlay PNGs
  are unchanged.
- No other caller (§2). No frontend change required — `FrameViewer` already calls the run endpoint;
  the fix is backend-only.

**Drift-prevention argument:** after (b)-lite there is a single definition of the per-frame array
and CSV. A future change to frame/CSV shape is a one-place edit that both downloads inherit
simultaneously; they cannot silently diverge the way they did between Phase 3c and 5A.

---

## 4. Implementation sketch (no code)

**Where the shared function lives.** Extract to `server/handlers/` (precedent:
`templateMaskApply.ts` was extracted in 3c for this same dedup reason). Suggested file
`server/handlers/frameManifest.ts` exporting one core builder, e.g.
`buildPerFrameManifestAndCsv(input) → { frames, csv }`.

**Proposed signature (shapes, not code):**

- **Input:**
  - `frames`: the ordered frame identity list — sorted-position `i` plus the `ext`/`outputFormat`
    needed to synthesize the `filename` cell. (Callers pass their own frame source; see below.)
  - `labels`: an **already approval-filtered** array of the labels whose per-frame data goes into
    the manifest (D2 enforced by the caller, not the core).
  - `confidenceFor(label, i)`: the per-frame confidence lookup (the current
    `getLabelFrameConfidence` logic — `frameResults[i].confidence ?? label.confidence`).
  - `outputFormat`: for the `filename` field (`job.outputSettings?.format || 'png'`).
- **Output:** `{ frames: ManifestFrame[], csv: string }` with `ManifestFrame` =
  `{ frame_number, filename, split, has_mask, ai_labels[] }` — the exact current shape
  (`routes.ts:647–653`). CSV headers exactly
  `filename,frame_number,split,ai_target,ai_confidence`.

**Wrappers:**

- *Whole-job wrapper:* feeds `listFrameFiles(job.id)` output + approved `job.aiLabels` +
  `outputFormat`; wraps output in the unchanged job-level manifest and appends the unchanged CSV.
  Output must be byte-identical to today.
- *Run wrapper:* filters `run.labels` to approved, derives its frame set (below), calls the core,
  then **adds** `frames[]` to the existing run manifest object and appends the CSV to the run ZIP.

**Manifest field additions to the run output (additive, D1):**
- `frames`: `Array<{ frame_number:number, filename:string, split:'train'|'val'|'test',
  has_mask:boolean, ai_labels: Array<{ intent, target, modality, confidence, model, approved,
  bbox }> }>` — identical element shape to the whole-job builder.
- New ZIP entry `metadata.csv` (see below). All ten existing run-manifest keys unchanged.

**CSV columns for the run download:** **identical headers** to the whole-job CSV
(`filename,frame_number,split,ai_target,ai_confidence`). `ai_target`/`ai_confidence` are the run's
approved label(s) (one, given the invariant), semicolon-join logic reused unchanged. Identical
column set keeps a single CSV parser working for both ZIPs.

**Frame source for the run's `frames[]` (design decision — recommendation, confirm in §6):**
Enumerate from the **run's own artifacts** — the `mask_<i>.png` files already listed at
`routes.ts:1742` (`maskFiles`, sorted) — using their sorted position `i` as `frame_number`,
matching `label.frameResults[i]`. **Do not** reuse `listFrameFiles(template_mask)`: a run with
`inputSource==='raw'` (no template mask applied) has an empty `template_mask` dir, so a
template-mask-based count would wrongly yield zero frames for a legitimately-populated run. The
run's mask-file list is the authoritative, input-source-agnostic frame set.

**`filename` cell in the run's `frames[]` (design decision — confirm in §6):** the run ZIP has no
`images/`, so the whole-job semantics (filename → a base frame that isn't in this ZIP) don't map
cleanly. Recommended for field-compatibility: keep `filename` as the synthesized
`frame_${padStart}.${outputFormat}` form (a stable per-frame identifier a downstream parser can
key on), and rely on `has_mask` + the `masks/mask_<i>.png` entries already in the ZIP to locate
artifacts. Alternative (point `filename` at `mask_<i>.png`) diverges from the whole-job shape and
is **not** recommended.

**Zero-approved-labels behavior (proposed, matches the whole-job precedent):** mirror what the
whole-job builder already does when `approvedLabels` is empty — it still lists **every** frame,
each with `ai_labels: []`, and the CSV still has one row per frame with empty `ai_target`/
`ai_confidence` cells (`routes.ts:633–654,726–732`). So for the run download with an unapproved
sole label: **`frames[]` is fully populated (one entry per run frame) with empty `ai_labels[]`,
and `metadata.csv` has header + one row per frame with empty label columns.** This keeps the two
downloads' zero-approved semantics identical and satisfies D2 (approved-only per-frame *label*
data — frames themselves are still listed). This case is reachable because "Continue to Download"
fires regardless of approval (§2.1).

**tsc:** the extraction is a pure code move + two call sites; it must not add or remove any of the
17 baseline errors. Confirm `npx tsc --noEmit` stays at 17 after implementation.

---

## 5. Smoke-test outline (post-deploy, operator)

Covers **both** download paths. Run after the live-verification sweep in §2.2.

**Pre-deploy capture (for the D1 diff).** *Before* deploying Phase 6, on the current build:
download a whole-job ZIP for a known test job (Path A in §2.2), extract `manifest.json` and
`metadata.csv`, and save them as `whole_job_manifest_BEFORE.json` /
`metadata_BEFORE.csv`. These are the D1 baseline.

**Test 1 — whole-job download unchanged (D1).**
1. After deploy, download the whole-job ZIP for the same test job.
2. Extract its `manifest.json` and `metadata.csv`.
3. Diff against the BEFORE files (`diff whole_job_manifest_BEFORE.json <new manifest.json>` — the
   only expected differences are `export_timestamp` and, if a new job, `job_id`; **no field
   renamed, removed, retyped, or reordered structurally**). CSV diff should be empty except for
   any timestamp-derived rows (there are none — CSV has no timestamp, so expect an **empty diff**).
4. Confirm the ZIP still contains `manifest.json`, `README.txt`, `metadata.csv`, `images/`.

**Test 2 — run download gains `frames[]` + CSV.**
1. Run one AI inference, open the frame viewer, click **Continue to Download**.
2. Open the run ZIP. Confirm: `masks/` + `overlays/` PNGs present (as before), **plus** a
   `manifest.json` that now contains a `frames[]` array, **plus** a new `metadata.csv`.
3. Confirm every pre-existing run-manifest field (`jobId`, `runId`, `runName`, `target`,
   `modality`, `inputSource`, `createdAt`, `labels[]`, `maskCount`, `overlayCount`) is still
   present and unchanged.
4. **Approved-only check:** in the AI spoke, toggle the label's approval **off**, re-download.
   Confirm `frames[]` entries now have empty `ai_labels[]` and the CSV rows have empty
   `ai_target`/`ai_confidence` (per §4). Toggle approval back **on**, re-download, confirm the
   per-frame label data returns.

**Test 3 — zero-approved case** (subsumed by Test 2 step 4): with the sole label unapproved, the
run ZIP still has `frames[]` (one entry per frame, empty `ai_labels`) + header+rows CSV, not an
empty file. Confirm against §4's proposed behavior.

---

## 6. Observations (noticed but OUT OF SCOPE — recorded, not fixed)

1. **Manifest `filename` padding vs actual image path (whole-job).** `frames[].filename` uses
   **4-pad** `frame_%04d.<outputFormat>` (`routes.ts:649`) while the archived image is **6-pad**
   `images/frame_%06d.<ext>` (`:773–775`), and `ext` (real source extension) can differ from
   `outputFormat`. So the manifest's `filename` field does not equal the ZIP path of the frame.
   Pre-existing; D1 requires keeping it as-is. **Flag only.**
2. **`has_mask: true` is hardcoded** per frame in the whole-job builder (`:651`) regardless of
   whether a mask exists on disk. Pre-existing. (If the run wrapper computes `has_mask` from real
   disk state, the two builders' `has_mask` semantics would differ — worth a deliberate decision,
   but changing the whole-job value would violate D1, so leave it hardcoded and document the run
   side's choice.)
3. **`inference.json` and the whole-job builder count frames from `template_mask`**
   (`countFrames`/`listFrameFiles` default base, `routes.ts:1402`, `:551`). A `raw`-inputSource
   run's artifacts are indexed against the raw frame list, so template-mask-based counting can
   misalign or be empty for such runs. This is adjacent to **backlog item 15** (masked-vs-raw
   asymmetry) — **explicitly parked.** It is the reason §4 recommends sourcing the run's frames
   from `run.outputDir`, not from `template_mask`.
4. **Run builder reads `run.outputDir` with a bare `fs.readdirSync`** (`:1737`) rather than a
   `frameAccess.ts` bounded resolver. The path comes from storage (trusted), so this isn't a live
   traversal risk, but it's inconsistent with the bounded-resolver convention used elsewhere.
   Not touched.
5. **archiver compression level differs** (whole-job `9` at `:742`, run `1` at `:1769`). Cosmetic
   perf only; leaving it avoids needless change to a working path.

---

## 7. Open questions for the operator

1. **Run `frames[].filename` semantics** — keep the field-compatible synthesized
   `frame_%04d.<outputFormat>` (recommended, one parser for both ZIPs), or point it at the actual
   `mask_<i>.png` present in the run ZIP? Recommendation: field-compatible.
2. **Run frame source** — enumerate the run's `frames[]` from the run's own `mask_` files
   (recommended; input-source-agnostic, handles `raw` runs) vs. from `template_mask`? Recommendation:
   run's own `mask_` files.
3. **Does the run ZIP need base-frame `images/` too, to fully match the whole-job export?** D3
   mandates `frames[]` + CSV but is silent on base frames. Recommendation: **no** — keep the run
   ZIP's current PNG payload (masks/overlays) and add only `frames[]` + `metadata.csv`; adding
   `images/` would require the run to also resolve and read the base frames (and re-introduces the
   `template_mask`-vs-`raw` source question). Confirm this is acceptable, since it means the two
   ZIPs still differ in payload (base frames) even after their manifests/CSVs are reconciled.
