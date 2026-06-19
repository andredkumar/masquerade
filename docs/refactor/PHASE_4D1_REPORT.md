# Phase 4d-1 — Implementation report

**Status:** IMPLEMENTED. Three frontend migrations + one surgical backend payload
addition (per `PHASE_4D1_AMENDMENT.md` Change 1) + the exhaustive audit.
**Date:** 2026-06-18
**Files changed:** `client/src/components/CommandInput.tsx`,
`client/src/components/ProcessingStatus.tsx`,
`client/src/components/FrameViewer.tsx`, `server/routes.ts` (one handler),
`CLAUDE.md`, `docs/refactor/PHASE_4D1_PROPOSAL.md` (amended), and this report.
**tsc:** `npx tsc --noEmit` → **exactly 17 errors** (10 `frameExtractor.ts` +
7 `maskWorker.ts`) — unchanged baseline, zero new errors.
**Removed:** nothing. All legacy routes remain registered (removal is 4d-2).

---

## 1. Straggler migrations

### 1.1 `CommandInput.tsx:480` — AI infer
- `POST /api/ai/infer` → `` `POST /api/jobs/${jobId}/ai/runs` ``.
- Same shared `aiInferHandler` (`routes.ts`), registered on both the legacy and
  canonical paths; it reads `jobId = req.params.jobId ?? req.body.jobId`, so the
  request body is unchanged (the redundant body `jobId` is harmless and left in
  place to keep the diff to one line). Response identical → the
  `onMaskGenerated`/overlay/confidence flow is unchanged.
- Shared with `home.tsx`; migrating changes the URL for both callers, which is
  fine — home.tsx is deleted in 4d-2 and the canonical URL works regardless of
  caller.

### 1.2 `ProcessingStatus.tsx:88` — template-mask download
- `GET /api/videos/${jobId}/download` →
  `` `GET /api/jobs/${jobId}/template-mask/download` ``.
- `ProcessingStatus` is rendered by the canonical `template-mask-spoke.tsx`, so
  this was a live straggler. `home.tsx:175`'s own download copy (with the
  output-settings query string) is intentionally left for 4d-2.

### 1.3 `FrameViewer.tsx` — overlay URL via backend runId-in-payload (amendment Change 1)
- **Old:** `` `GET /api/jobs/${jobId}/overlays/${labelId}/${n}.png` `` — the
  legacy **labelId-only** alias (`FrameViewer.tsx:225`, pre-change).
- **New:** `` `GET /api/jobs/${jobId}/ai/runs/${runId}/overlays/${labelId}/${n}.png` ``
  — the canonical runId-scoped form, built directly from the per-frame payload.
- Frontend edits:
  - `PerFrameLabel` interface gains `runId: string | null` (`FrameViewer.tsx:32–43`).
  - `overlayUrl(runId, labelId, n)` rewritten to the canonical form
    (`FrameViewer.tsx:230–234`).
  - Render callsite: `overlayUrl(l.runId as string, l.labelId, currentFrame)`,
    with the existing overlay filter tightened to
    `.filter(l => l.hasMask && l.runId)` (`FrameViewer.tsx:386–391`).
  - Prefetch callsite: finds the matching per-frame label and uses its `runId`
    (`FrameViewer.tsx:274–280`).
- **No third fetch, no `labelId→runId` map, no fallback to the legacy alias.**
  This is the key amendment requirement: the legacy fallback that the original
  proposal §2.3 chose would have been a silent dependency that 404s in the
  one-way 4d-2 removal. Giving FrameViewer the runId directly eliminates it.

---

## 2. The surgical backend change (documented exactly, per amendment)

**Handler:** `GET /api/jobs/:jobId/inference.json` (`server/routes.ts`).
**Why this handler:** FrameViewer builds overlay URLs **only** from
`PerFrameLabel` objects, and those objects come **only** from `inference.json`'s
`frames` map. `viewer-info` feeds the labels panel / default-visible set, never
an overlay URL, so it needed **no** change.

**Scope-guard check (passed, no STOP needed):** the run↔label association was
**already materialized at the construction site** — the handler builds
`labelDirMap` by iterating the runs list (`storage.listAiRuns`) for the existing
disk-based `hasMask` check. Adding `runId` is therefore a localized field
addition, not a structural change.

**The two edits:**

1. In the existing `labelDirMap` build loop, add a parallel `labelRunIdMap`:
   ```ts
   const inferRuns = await storage.listAiRuns(req.params.jobId);
   const labelDirMap = new Map<string, string>();
   const labelRunIdMap = new Map<string, string>();   // ← added
   for (const r of inferRuns) {
     for (const rl of r.labels) {
       labelDirMap.set(rl.id, r.outputDir);
       labelRunIdMap.set(rl.id, r.id);                 // ← added; runId = AIRun.id
     }
   }
   ```
2. Emit `runId` on each per-frame label object:
   ```ts
   perFrame.push({
     labelId: l.id,
     runId: labelRunIdMap.get(l.id) ?? null,           // ← added
     name: l.target,
     modality: l.modality || null,
     confidence: r.confidence,
     bbox: l.bbox || null,
     approved: l.approved,
     hasMask,
   });
   ```

**How `runId` is sourced:** from `AIRun.id` — the run that owns the label — read
from `storage.listAiRuns(jobId)`. This is the same source the 4b-ii AI-spoke
migration used for its runId-scoped mutation URLs.

**Why `?? null` is safe / when `runId` is guaranteed present:** an overlay is
rendered only for labels where `hasMask` is true (`FrameViewer.tsx:386` filter),
and `hasMask` is itself true only when `labelDirMap.get(l.id)` resolved a run dir
(`routes.ts`, `hasMask = !!runDir && fs.existsSync(...)`). Since `labelDirMap`
and `labelRunIdMap` are populated in the same loop from the same runs, any label
with a resolved dir also has a resolved runId. So `runId` is non-null exactly
when it is used; the `?? null` only covers the never-rendered case. The frontend
filter `l.hasMask && l.runId` makes this explicit on the client side too.

**Nothing else in the backend changed:** no route registration, no other
handler, no touch to the b734e6d re-entrancy fix, `applyPaths.ts`, the tripwire,
or retention.

---

## 3. THE exhaustive audit (the 4d-2 gate)

Every legacy URL slated for 4d-2 removal, grepped across all of `client/`, with
every hit at `file:line`, classified, and given a yes/no removal verdict. Per
amendment Change 2, every "safe = yes" row shows the grep that **proves zero
remaining frontend constructors**, rather than asserting it.

### 3.1 Grep evidence (commands run against `client/`)

| Grep pattern | Hits (`file:line`) |
|---|---|
| `/api/videos/upload\|/api/images/upload` | `FileUpload.tsx:35` |
| `/api/ai/infer` | **none** |
| `/api/ai/labels/` | `home.tsx:118`, `home.tsx:136`, `home.tsx:150` |
| `/api/videos/` | `home.tsx:175` (download), `FileUpload.tsx:35` (upload) |
| `mask-processing` | **none** |
| `overlays/` | `FrameViewer.tsx:232` (canonical runId-scoped only) |
| `masks/` | **none** |
| `template-mask/download` (canonical) | `ProcessingStatus.tsx:88` |
| `ai/runs` (canonical) | `ai-spoke.tsx:101,136,150`, `CommandInput.tsx:480`, `FrameViewer.tsx:232` |

### 3.2 Per-URL removal verdict table

| Legacy URL | `client/` constructors (`file:line`) | Classification | Safe to remove in 4d-2? |
|---|---|---|---|
| `POST /api/videos/upload` | `FileUpload.tsx:35` | (b) home.tsx-only (FileUpload imported only by `home.tsx:3`) | **YES** — dies with the file |
| `POST /api/images/upload` | `FileUpload.tsx:35` | (b) home.tsx-only | **YES** — dies with the file |
| `GET /api/videos/:jobId` (bare) | **none** | poll removed in 4b-ii; grep for `/api/videos/` shows only `/upload` + `/download`, no bare GET | **YES** — zero constructors |
| `GET /api/videos/:jobId/download` | `home.tsx:175` | (b) home.tsx-only (canonical app uses `ProcessingStatus.tsx:88` → `template-mask/download`) | **YES** — dies with the file |
| `PATCH /internal/mask-processing/:jobId` | **none** | (no frontend consumer) | **YES** — zero constructors |
| `POST /api/ai/infer` | **none** | (a) migrated 4d-1 (`CommandInput.tsx:480` now canonical) | **YES** — zero constructors |
| `PATCH /api/ai/labels/:jobId/:labelId` | `home.tsx:136` | (b) home.tsx-only (AI spoke uses runId-scoped, 4b-ii) | **YES** — dies with the file |
| `DELETE /api/ai/labels/:jobId/:labelId` | `home.tsx:150` | (b) home.tsx-only | **YES** — dies with the file |
| `GET /api/ai/labels/:jobId` (source) | `home.tsx:118` | (b) home.tsx-only | **YES** — dies with the file |
| `GET /api/jobs/:jobId/masks/:labelId/:n.png` (labelId-only) | **none** | (no frontend consumer — FrameViewer fetches overlays, never masks) | **YES** — zero constructors |
| `GET /api/jobs/:jobId/overlays/:labelId/:n.png` (labelId-only) | **none** | (a) migrated 4d-1; the only `overlays/` hit is the canonical runId-scoped form at `FrameViewer.tsx:232` | **YES** — zero constructors |

**No row is classified (c) "still-live elsewhere." There are zero BLOCKERS for
4d-2.**

### 3.3 Amendment Change 2 — "prove the negative" callouts

- **Legacy labelId-only overlay alias** (`GET /api/jobs/:jobId/overlays/:labelId/:n.png`):
  grep `overlays/` across `client/` returns exactly **one** hit —
  `FrameViewer.tsx:232`, the canonical `/ai/runs/${runId}/overlays/...` form.
  There is no other overlay constructor anywhere in `client/`, including any
  fallback/default/error path (the migration deliberately removed the fallback).
  **Proven, not asserted.**
- **`/api/ai/infer`:** grep returns **no matches** in `client/`. The previous
  sole constructor (`CommandInput.tsx`) is now canonical. **Proven.**
- **labelId-only `masks/` alias:** grep `masks/` returns **no matches** in
  `client/`. **Proven.**
- **`/internal/mask-processing/:jobId`:** grep `mask-processing` returns **no
  matches** in `client/`. **Proven.**
- **bare `GET /api/videos/:jobId`:** grep `/api/videos/` returns only the
  `/upload` and `/download` forms; there is no bare `` `/api/videos/${...}` ``
  GET. **Proven.**

### 3.4 Already-canonical (confirmed — no action)
- Upload: `upload.tsx:117` uses `/api/uploads/video` + `/api/uploads/images`.
  The canonical app never hits legacy `/api/videos/upload`/`/api/images/upload`
  (only the dying `FileUpload`/home.tsx does).
- AI spoke (4b-ii): labels via `GET /api/jobs/:jobId/ai/runs`; approve/delete
  runId-scoped (`ai-spoke.tsx:101,136,150`).
- Template-mask spoke (4b-i): apply + frame preview on canonical URLs.

---

## 4. Constraints honored
- **Removed nothing.** All legacy routes/aliases still registered; `home.tsx`,
  `FileUpload.tsx`, and `/app` untouched (4d-2 owns removal).
- Backend change limited to the **one** surgical `runId` field addition in the
  `inference.json` handler. No route registration changes; no touch to the
  b734e6d re-entrancy fix, `applyPaths.ts`, the tripwire, or retention.
- `home.tsx`'s legacy URLs and the redundant `CommandInput` body `jobId` left
  in place deliberately.
- `npx tsc --noEmit` remains exactly **17**.

---

## 5. Verification

### 5.1 Done (static / build)
- ✅ **tsc = 17** (baseline; all 17 in `frameExtractor.ts` (10) + `maskWorker.ts`
  (7); zero new errors from the 4d-1 edits).
- ✅ **Audit greps** (§3) — every legacy removal-list URL has its `client/`
  constructors enumerated; zero BLOCKERS; the "prove the negative" callouts for
  every "safe = yes" row.
- ✅ **Canonical replacements present:** `CommandInput.tsx:480` (infer),
  `ProcessingStatus.tsx:88` (download), `FrameViewer.tsx:232` (overlay).

### 5.2 Runtime (to run against a live server — checklist)
1. **Infer:** run AI analysis from the canonical AI spoke → DevTools shows
   `POST /api/jobs/:jobId/ai/runs` (no `POST /api/ai/infer`); masks/overlays
   produced as before.
2. **Overlay (key new behavior):** in the frame viewer, toggle **Overlay** for
   an approved, masked label → DevTools shows
   `GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png` and **no**
   labelId-only overlay request. Overlays render; prefetch warms neighbors with
   the same canonical URL.
3. **Download:** template-mask spoke download → `GET /api/jobs/:jobId/template-mask/download`
   (no `/api/videos/:jobId/download`); ZIP yields.
4. **No regression:** raw + masked frames still serve; the `applyPaths` tripwire
   stays green (`npx tsx server/services/__tests__/applyPaths.test.ts`).

---

## 6. Summary
The two approved straggler migrations (CommandInput infer, ProcessingStatus
download), the FrameViewer overlay migration backed by the single surgical
`inference.json` `runId` addition (amendment Change 1, no frontend fallback), the
CLAUDE.md ledger update (4d-1 landed + the two flagged-not-fixed canvas-polish
bugs), and the exhaustive audit table with "prove the negative" evidence
(amendment Change 2) are all implemented. Nothing was removed; the tsc baseline
holds at 17. The audit shows **zero BLOCKERS** — every legacy removal-list URL is
either migrated (zero remaining constructors) or survives only in the
4d-2-doomed `home.tsx`/`FileUpload.tsx`. 4d-2 (the one-way teardown) is a
separate kickoff that starts only after this deploys.
