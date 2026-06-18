# Phase 4b-ii — Implementation report

**Status:** IMPLEMENTED. Frontend + docs only; zero backend changes.
**Date:** 2026-06-18
**Files changed:** `client/src/pages/ai-spoke.tsx`, `CLAUDE.md`, and this report
(plus the proposal updated per the amendment).
**tsc:** `npx tsc --noEmit` → **exactly 17 errors** (10 `frameExtractor.ts` +
7 `maskWorker.ts`) — unchanged baseline, zero new errors.

This implements the approved `PHASE_4B_II_PROPOSAL.md` with the two required
changes from `PHASE_4B_II_AMENDMENT.md` (ready-gate instead of mask-completion
gate; defensive flatten).

---

## 1. What changed in `ai-spoke.tsx`

### 1.1 Imports + local view type
- Added `AIRun` to the `@shared/schema` type import.
- Removed the now-unused `useQuery` import (`@tanstack/react-query`).
- Added a local view type (no `@shared/schema` change):
  ```ts
  type AiLabelWithRun = AiLabel & { runId: string };
  ```
  This is a superset of `AiLabel`, so every existing render read
  (`label.id`, `.target`, `.intent`, `.model`, `.confidence`, `.approved`,
  `(label as any).frameResults`, `colorForLabelId(label.id)`) is unchanged.

### 1.2 Part A — canonical-URL migration (source-first)
- **Label SOURCE** migrated from the flat legacy endpoint to the runs hierarchy:
  - was `GET /api/ai/labels/:jobId` → `{ labels: AiLabel[] }` (no runId)
  - now `GET /api/jobs/:jobId/ai/runs` → `{ runs: AIRun[] }`, flattened with
    each label carrying its owning `runId`:
    ```ts
    const runs: AIRun[] = data.runs || [];
    const flattened: AiLabelWithRun[] = runs.flatMap((r) =>
      (r.labels ?? []).map((l) => ({ ...l, runId: r.id })),
    );
    ```
    The `(r.labels ?? [])` is the **amendment's Change 2** defensive flatten —
    `flatMap` already handles multi-label runs; the guard prevents a run with
    zero/undefined labels from breaking the list. (1:1 run↔label is a
    current-impl property, not a guaranteed invariant.)
- `aiLabels` state retyped `useState<AiLabelWithRun[]>([])`.
- **Mutations** migrated to runId-scoped canonical URLs:
  - `handleToggleLabel(label: AiLabelWithRun, approved)` and
    `handleRemoveLabel(label: AiLabelWithRun)` now call
    `PATCH|DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId`, where
    `runId` comes from `label.runId` supplied by the runs-based source. This is
    why the source migration had to come first — the flat source could not
    supply a runId for the path.
  - `handleDeleteLabelWithConfirm(label: AiLabelWithRun)` now passes the full
    `label` to `handleRemoveLabel`; the `window.confirm` guard is unchanged.
  - The approve-toggle button callsite passes `label` (was `label.id`).

### 1.3 Status gate — `ready`, not mask completion (amendment Change 1)
- Removed the legacy 2s react-query poll on `GET /api/videos/:jobId`
  (`useQuery({ queryKey: ["/api/videos", jobId], refetchInterval: 2000 })`)
  and the `jobCompleted = legacyJob?.status === "completed"` derivation.
- Replaced with the live `useJob()` extraction status:
  ```ts
  const jobReady = job?.status === "ready";
  ```
- `jobReady` replaces `jobCompleted` at all four gate callsites (the AI tools
  block, the frame-viewer toggle, and the viewer render condition) and the
  label-fetch effect (`useEffect(() => { if (jobReady) fetchLabels(); }, ...)`).
- The empty-state copy changed from "Template mask processing must complete
  before AI analysis is available." to "Upload processing must finish before AI
  analysis is available." — accurate for the extraction-based gate.

**Why this is safe to run mask-free (verified, no STOP/flag needed).** The AI
inference handler `aiInferHandler` (`routes.ts:879`) implements spoke
independence: it tries template-masked frames (line 917), **falls back to raw
frames on disk** (`listRawFrameFiles`, lines 920–921), then to a request-body
`frameBase64` (line 924). Comment at `routes.ts:915–916`: *"Hotfix 4: spoke
independence — AI can run without a template mask applied."* So `ready` alone is
sufficient.

**Liveness of `ready`.** `MemStorage.updateVideoJob` mirrors legacy status to
`Job.status` via `mapVideoJobStatusToJobStatus` (`storage.ts:128–132`), and
`processVideo` emits `io.emit('progress', { jobId, ... })`
(`videoProcessor.ts:1081`); `JobContext` filters by jobId and refetches
`GET /api/jobs/:jobId` (`JobContext.tsx:53–59`), so `useJob().job.status`
reflects `ready` live without a dedicated poll.

### 1.4 Part B — masked-frame staleness fix
- Added `const maskVersion = job?.templateMask?.completedAt ?? "";`.
- The masked-source fetch now appends a version param **only when a mask exists**:
  ```ts
  const v = maskVersion ? `&v=${encodeURIComponent(maskVersion)}` : "";
  let res = await fetch(`/api/jobs/${jobId}/frames/0?source=template_mask${v}`);
  if (res.status === 404) {
    res = await fetch(`/api/jobs/${jobId}/frames/0`); // raw fallback — UNCHANGED, unversioned
  }
  ```
- Added `maskVersion` to the effect deps (`[jobId, maskVersion]`), so an
  in-place re-apply re-runs the fetch.
- `completedAt` is refreshed on every successful apply
  (`videoProcessor.ts:412–418`), so the masked URL changes per apply → browser
  cache miss → fresh masked PNG. The frames endpoint reads only `?source`
  (`routes.ts:1611`), so the extra `&v` is ignored server-side — no backend
  change, no cache-header change, no protected-file edit.
- Raw fallback stays unversioned; global frame-cache policy is untouched.

### 1.5 Out of scope (flagged, not changed)
- `CommandInput.tsx`'s `POST /api/ai/infer` — shared component also used by
  legacy `home.tsx`; its migration is deferred to 4c/4d.
- Legacy URL **removal** (4d). Legacy routes remain registered and working.

---

## 2. CLAUDE.md edits
- New dated sections inserted after the Phase 4b-0 FIX V2 block:
  - **Phase 4b-0 landed + deploy-verified on main @ b734e6d (2026-06-17).**
  - **Phase 4b-i landed** — template-mask spoke on canonical URLs
    (`ProcessingControls.tsx` apply trigger + `template-mask-spoke.tsx` frame
    preview). Reconciles the 4b sub-phase ledger against actual code.
  - **Phase 4b-ii landed** — the AI-spoke URL migration, the ready-gate change,
    and the masked-frame staleness fix (this work).
  - **Frame-deletion "bug" was a PHANTOM** — records the audit conclusion and
    that `🗑️ template_mask cleanup on AI-run delete` is correct, intended
    behavior.
- Appended the **post-mortem lessons** to the 4b-0 FIX V2 area (re-entrancy
  testing, logging `path.resolve` targets, isolation of persistence tests, not
  baking a hypothesis into a diagnostic).
- No existing landed-phase text deleted.

---

## 3. Constraints honored
- No touch to b734e6d re-entrancy fix, `applyPaths.ts`, `_apply` isolation, or
  the tripwire.
- Protected files (`videoProcessor.ts`, `frameExtractor.ts`,
  `tempFolderManager.ts`, `frameAccess.ts`, `templateMaskApply.ts`,
  `sam2-service/`, `server/routes.ts` handlers) are read-only — confirmed not
  edited (only read for shape verification).
- Legacy URLs stay registered (removal is 4d).
- No retention/`SWEEP_TARGETS` change, no `global.extractedFrames`, no
  three-path consolidation, no global frame-cache change.
- `npx tsc --noEmit` remains exactly 17 errors.

---

## 4. Verification

### 4.1 Done (static / build)
- ✅ **tsc = 17** (baseline, no new errors). See run output: all 17 are in
  `frameExtractor.ts` (10) and `maskWorker.ts` (7).
- ✅ **No stale references** in `ai-spoke.tsx`: grep for
  `jobCompleted | useQuery | legacyJob | /api/ai/labels` → no matches.
- ✅ **Schema soundness:** `AIRun.id: string` and `AIRun.labels: AiLabel[]`
  (`schema.ts:225–236`); `TemplateMaskState.completedAt: string | null`
  (`schema.ts:204`) — the flatten and `maskVersion` access are type-correct.

### 4.2 Runtime (to run against a live server — checklist)
1. **URL migration (DevTools Network):** approve/delete a label →
   `PATCH|DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId`; label list
   loads from `GET /api/jobs/:jobId/ai/runs`. No `GET /api/videos/:jobId` poll
   fires from the AI spoke.
2. **AI-without-mask (key new behavior):** upload a job, go STRAIGHT to the AI
   spoke WITHOUT applying a template mask. Spoke is enterable once `ready`,
   frame 0 renders via raw fallback, AI runs on raw frames. DevTools shows
   `?source=template_mask` → **404** → raw `GET /api/jobs/:jobId/frames/0`
   (no `&v=`).
3. **Staleness (masked path):** apply mask #1 → AI spoke shows mask #1 → delete
   the run → apply a *different* mask #2 → AI spoke shows **mask #2** without a
   hard reload. Confirm the masked request carries `&v=<completedAt>`.
4. **No regression:** raw frames still serve; the tripwire test stays green
   (`npx tsx server/services/__tests__/applyPaths.test.ts`); template-mask spoke
   apply still works.

---

## 5. Summary
Part A (canonical URLs, source-first), Part B (masked-frame staleness), the
amendment's ready-gate (optional masking) and defensive flatten, and the CLAUDE.md
ledger updates are all implemented. The change is frontend-only with the tsc
baseline preserved at 17. Items 1–4 in §4.2 require a running server and remain
as the manual runtime checklist.
