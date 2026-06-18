# Phase 4b-ii — AI-spoke canonical-URL migration + masked-frame staleness fix

**Status:** PROPOSAL — awaiting approval. No code changed yet.
**Scope:** Frontend-primary (`client/src/pages/ai-spoke.tsx`). Zero backend
changes required (verified below). One docs file (`CLAUDE.md`).

---

## 0. Premise & constraints (acknowledged)

- The "frames auto-deleted after upload" bug is a **PHANTOM** (kickoff §0). This
  proposal does **not** treat it as real and does **not** touch any deletion
  path, the b734e6d re-entrancy fix, `applyPaths.ts`, `_apply` isolation, or the
  tripwire.
- Legacy URLs stay registered and working (their removal is 4d). This migration
  only changes which URLs the **AI spoke** calls.
- No retention / `SWEEP_TARGETS` changes; no `global.extractedFrames`; no
  three-path consolidation; no blanket frame-cache change.
- `npx tsc --noEmit` baseline stays **exactly 17** (10 `frameExtractor.ts` +
  7 `maskWorker.ts`). This change adds no new type errors.
- Protected files (`videoProcessor.ts`, `frameExtractor.ts`,
  `tempFolderManager.ts`, `frameAccess.ts`, `templateMaskApply.ts`,
  `sam2-service/`, `server/routes.ts` handlers) are **read-only** for this work.
  The staleness fix does **not** require touching any of them — see §2.

---

## 1. Part A — AI-spoke canonical-URL migration

### 1.1 Current legacy callsites (all in `client/src/pages/ai-spoke.tsx`)

| Line | Purpose | Current (legacy) URL | Payload / method |
|---|---|---|---|
| 86 | Label SOURCE | `GET /api/ai/labels/${jobId}` | → `{ labels: AiLabel[] }` (flat, **no runId**) |
| 117 | Approve toggle | `PATCH /api/ai/labels/${jobId}/${labelId}` | body `{ approved }` → `{ label }` |
| 131 | Delete label | `DELETE /api/ai/labels/${jobId}/${labelId}` | → `{ success: true }` |
| 74–80 | Status gate | `GET /api/videos/${jobId}` via react-query `refetchInterval: 2000` | `legacyJob.status === "completed"` |

### 1.2 The runId problem (why this is NOT a find-and-replace)

The canonical mutation URLs require **runId in the path**:

```
PATCH  /api/jobs/:jobId/ai/runs/:runId/labels/:labelId
DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId
```

The legacy label source (`GET /api/ai/labels/:jobId`) returns a **flat
`AiLabel[]` with no runId**, so there is no way to construct a canonical
mutation URL from it. The fix is **source-first**: switch the label source to
the runs-based endpoint, which groups labels under runs so each label can carry
its owning runId.

**Verified backend shapes:**

- `GET /api/jobs/:jobId/ai/runs` → `{ runs: AIRun[] }` (`routes.ts:1695`). Each
  `AIRun` has `id` (the runId) and `labels: AiLabel[]` (`schema.ts:225–236`).
- Phase 3b invariant: **each `AIRun` has exactly one label** (runId ↔ labelId is
  1:1). The dual-write keeps `AIRun.labels[]` in sync with the flat
  `job.aiLabels` (`routes.ts:1172–1185`, `1206–1227`), so the runs source
  returns the same labels the flat source does — plus the runId.
- The shared `patchLabelHandler` / `deleteLabelHandler` resolve the run via
  `req.params.runId ?? findRunByLabelId(...)` (`routes.ts:1177–1179`,
  `1217–1219`). Calling the canonical URL with a real runId takes the
  `req.params.runId` branch — fully functional, same `{ label }` /
  `{ success: true }` responses.

### 1.3 Migration plan (source-first, then mutations)

**Step 1 — migrate the label SOURCE (`fetchLabels`, lines 83–94).**

Replace the flat fetch with the runs fetch, and flatten runs → labels while
attaching `runId` to each label:

```ts
// GET /api/jobs/:jobId/ai/runs  →  { runs: AIRun[] }
const res = await fetch(`/api/jobs/${jobId}/ai/runs`);
if (res.ok) {
  const data = await res.json();
  const runs: AIRun[] = data.runs ?? [];
  // Attach runId so mutations can build canonical URLs. `flatMap` handles
  // multi-label runs correctly (future-proof); `(r.labels ?? [])` guards a run
  // with zero/undefined labels (1:1 is a current-impl property, not guaranteed).
  const flattened = runs.flatMap((r) =>
    (r.labels ?? []).map((l) => ({ ...l, runId: r.id })),
  );
  setAiLabels(flattened);
}
```

This requires the local label list to carry `runId`. Introduce a local view type
(no `@shared/schema` change):

```ts
type AiLabelWithRun = AiLabel & { runId: string };
const [aiLabels, setAiLabels] = useState<AiLabelWithRun[]>([]);
```

All existing render reads (`label.id`, `label.target`, `label.intent`,
`label.model`, `label.confidence`, `label.approved`,
`(label as any).frameResults`, `colorForLabelId(label.id)`) are unchanged —
`AiLabelWithRun` is a superset of `AiLabel`.

**Step 2 — migrate the mutations to runId-scoped URLs.**

`handleToggleLabel` and `handleRemoveLabel` take the label's `runId` (now
available on each row) and build the canonical URL:

```ts
const handleToggleLabel = async (label: AiLabelWithRun, approved: boolean) => {
  await fetch(`/api/jobs/${jobId}/ai/runs/${label.runId}/labels/${label.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  await fetchLabels();
};

const handleRemoveLabel = async (label: AiLabelWithRun) => {
  await fetch(`/api/jobs/${jobId}/ai/runs/${label.runId}/labels/${label.id}`, {
    method: "DELETE",
  });
  await fetchLabels();
};
```

Callers (the buttons at lines 250, 274 and `handleDeleteLabelWithConfirm` at
138–144) pass the full `label` object instead of `label.id`. The
`window.confirm` delete-guard semantics are preserved unchanged.

**Step 3 — migrate the status gate (lines 74–80).** See §3 — verified removable.

### 1.4 Explicitly OUT of scope for Part A (flagged, not changed)

- **`CommandInput.tsx:480` → `POST /api/ai/infer`** (legacy infer trigger). This
  is a *shared* component also rendered by the legacy `home.tsx`; the kickoff's
  Part A list is the three ai-spoke label URLs + the status poll, and does not
  include the infer endpoint. Migrating `CommandInput` would touch the legacy
  `/app` path and is not in this scope. Recommend deferring to 4c/4d. **Flagging
  it here** so it is recorded, not forgotten.
- Legacy URL **removal** (4d).

---

## 2. Part B — masked-frame staleness fix

### 2.1 Confirmed mechanism (static analysis)

The masked-frame fetch (`ai-spoke.tsx:44–71`) is a **raw `fetch()` → blob →
objectURL**, *not* react-query — so there is **no query/state cache** for it.
Two independent mechanisms produce the stale frame:

1. **Effect deps are `[jobId]` only** (line 71). Re-applying a new template mask
   without unmounting the page never re-runs the fetch, so the old objectURL
   stays on the canvas.
2. **Browser HTTP cache.** The masked URL
   `GET /api/jobs/${jobId}/frames/0?source=template_mask` is byte-identical
   across re-applies, and the endpoint sets `Cache-Control: private, max-age=3600`
   (`routes.ts:1631`). Even on remount (effect re-runs), the browser serves the
   cached stale PNG.

Both are real depending on navigation (re-apply in place → #1; navigate
away/back → #2). A single fix covers both.

**Runtime confirmation step (to run during verification, per kickoff):** apply
mask #1 → open AI spoke → re-apply a *different* mask #2 → observe stale frame →
**hard reload**. If the new mask appears after hard reload, the HTTP cache (#2)
is confirmed; the in-place case confirms #1. Static analysis already identifies
both; the fix below addresses both regardless of which dominates at runtime.

### 2.2 Fix — version the masked-frame URL from `templateMask.completedAt`

`templateMaskState.completedAt` (`schema.ts:204`) is set to a fresh ISO
timestamp on every successful apply (`videoProcessor.ts:412–418`), and
`useJob()` delivers it **live** (see §3 liveness proof). Use it as a
cache-buster on the masked source **only**:

```ts
const maskVersion = job?.templateMask?.completedAt ?? "";

useEffect(() => {
  if (!jobId) return;
  // ... existing revoked/blobUrl bookkeeping ...
  const v = maskVersion ? `&v=${encodeURIComponent(maskVersion)}` : "";
  let res = await fetch(`/api/jobs/${jobId}/frames/0?source=template_mask${v}`);
  if (res.status === 404) {
    res = await fetch(`/api/jobs/${jobId}/frames/0`); // raw fallback — UNCHANGED, no version
  }
  // ...
}, [jobId, maskVersion]);   // ← add maskVersion to deps
```

Why this is correct and minimal:

- The frames endpoint reads only `req.query.source` (`routes.ts:1611`); the extra
  `v` param is **ignored server-side** — no backend change, no handler edit.
- `completedAt` changes on every apply → URL changes → browser cache miss →
  fresh masked PNG. Adding `maskVersion` to the deps re-runs the effect on
  in-place re-apply too.
- **Raw fallback is untouched** (no version param) — raw frames keep their
  `max-age=3600` caching. The global frame-cache policy is **not** changed; only
  the masked-source request URL gains a version param. This satisfies the
  kickoff's "target the masked-frame source, do not disable caching globally."

No `server/routes.ts` edit, no cache-header change, no protected-file edit.

---

## 3. Status-gate migration — gate on `ready`, NOT mask completion

> **AMENDMENT (approved 2026-06-18).** Template masking is **optional**
> preprocessing — a settled product decision. The AI spoke must be enterable and
> runnable as soon as the job's upload/extraction is done, whether or not a
> template mask was ever applied. Gating on `templateMask.status === 'complete'`
> would permanently lock out users who upload already-clean media (no PHI, or
> masked elsewhere), because their `templateMask.status` never reaches
> `'complete'`. The legacy `legacyJob.status === "completed"` gate (mask
> completion) was a **bug** that contradicts optional-masking; migration is where
> we fix it, not preserve it.

**Gate on V2 extraction status instead.** Replace the legacy 2s react-query poll
on `GET /api/videos/:jobId` with the live `useJob()` extraction status:

```ts
// remove the useQuery(["/api/videos", jobId], { refetchInterval: 2000 }) block
const jobReady = job?.status === "ready";   // upload/extraction complete
```

`jobReady` replaces the old `jobCompleted` variable everywhere it gates the AI
tools, the label list, and the frame-viewer toggle. (Rename for accuracy — it no
longer means "mask completed".)

**Technical feasibility verified (no genuine blocker to running AI mask-free).**
The AI inference handler `aiInferHandler` (`routes.ts:879`) already implements
spoke independence:
- tries template-masked frames first (`listFrameFiles(jobId)`, line 917),
- **falls back to raw frames on disk** (`listRawFrameFiles`, lines 920–921),
- then falls back to a request-body `frameBase64` (line 924).

Comment at `routes.ts:915–916`: *"Hotfix 4: spoke independence — AI can run
without a template mask applied."* So `ready` alone is sufficient — no STOP/flag
needed.

**Liveness of `ready`.** `useJob()` reflects extraction completion live:
1. Extraction/processing completion calls `storage.updateVideoJob(jobId, {
   status: 'completed' | 'ready' ... })`; `MemStorage.updateVideoJob` mirrors
   legacy status to `Job.status` via `mapVideoJobStatusToJobStatus`
   (`uploaded/extracting → extracting`; `ready/masking/processing/completed →
   ready`; `storage.ts:128–132`, Phase 4a hotfix 1).
2. `processVideo` emits `io.emit('progress', { jobId, ... })`
   (`videoProcessor.ts:1081`); `JobContext` filters `data.jobId === jobId` and
   refetches `GET /api/jobs/:jobId` (`JobContext.tsx:53–59`) → `useJob().job.status`
   is fresh.

Notes:
- The `progress` emit is a global broadcast (backlog #6), but `JobContext`
  filters by jobId, so correctness holds. Out of scope to fix here.
- Removing the poll also lets us drop the now-unused `useQuery` import if no
  other usage remains in the file (verify on edit).

**Masked-vs-raw composition (ties Part B to this gate).** Because the gate is now
`ready` (not mask completion), the masked-frame fetch's existing raw fallback is
load-bearing: if a mask was applied, the masked source serves it and the
`&v=completedAt` cache-bust applies; if no mask exists, `?source=template_mask`
404s and the fetch falls back to raw frame 0 with **no** version param (the
`maskVersion ? ... : ''` guard already yields `''` when `completedAt` is absent).
Unmasked jobs therefore render and run AI on raw frames — the intended
"masking optional" behavior.

---

## 4. CLAUDE.md edits (exact, additive)

Add a new dated section after the Phase 4b-0 FIX V2 block (after line 105), and
make the small reconciliations below. No existing landed-phase text is deleted.

### 4.1 New section — Phase 4b-ii

```md
### Phase 4b-ii landed — AI-spoke canonical URLs + masked-frame staleness (2026-06-18)

- AI spoke (`ai-spoke.tsx`) migrated off legacy flat label URLs to the canonical
  runs hierarchy:
  - Label SOURCE: `GET /api/ai/labels/:jobId` → `GET /api/jobs/:jobId/ai/runs`.
    Labels are flattened from `runs[*].labels[]` with each carrying its
    `runId` (Phase 3b 1:1 run↔label invariant makes this exact).
  - Approve/Delete: `PATCH|DELETE /api/ai/labels/:jobId/:labelId` →
    `PATCH|DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId`. runId comes
    from the runs-based source above (NOT derivable from the flat source — this
    is why source migration came first).
  - Status gate switched from the legacy 2s poll on `GET /api/videos/:jobId`
    (which gated on **mask completion** — a bug vs. optional-masking) to
    `useJob().job.status === 'ready'` (upload/extraction complete). Template
    masking is optional: AI runs on masked frames if a mask exists, else on raw
    frames via the inference handler's raw fallback (`routes.ts:920`).
- Masked-frame staleness fixed: the masked-frame canvas served a stale cached PNG
  after re-applying a new template mask. Root cause was twofold — the fetch
  effect depended only on `[jobId]` (no re-run on re-apply) and the masked URL
  was byte-identical under `Cache-Control: private, max-age=3600`. Fix appends a
  `&v=<templateMask.completedAt>` version param to the **masked source only** and
  adds it to the effect deps. Raw-frame caching is unchanged; the frames endpoint
  ignores the extra param (reads only `?source`). No backend change.
- Legacy URLs remain registered (removal is 4d). `CommandInput.tsx`'s
  `POST /api/ai/infer` is still legacy — it's a shared component also used by
  `home.tsx`; its migration is deferred to 4c/4d (out of 4b-ii scope).

### Frame-deletion "bug" was a PHANTOM (2026-06-18)

The "raw frames auto-deleted ~1s after upload" report was never reproduced under
controlled observation, and a full source/git/dist audit (see
`PHASE_4B0_FRAMEDELETE_PROPOSAL.md`) found **no current-source line** that deletes
`temp_extracted/<jobId>/` post-extraction. The post-download `cleanupJobArtifacts`
hook that once existed (commit f74692c) was removed (commit 36f684e) and is not
in HEAD (b734e6d). Do NOT chase this further. The `🗑️ template_mask cleanup on
AI-run delete` is **correct, intended** behavior (deleting a run removes its
`spokes/ai/<jobId>/<runId>/` artifacts) — not the phantom.
```

### 4.2 Reconciliations to existing text

- **Phase 4b-0 status:** confirm landed + deploy-verified at `b734e6d` (the FIX
  V2 block already documents the re-entrancy fix; add a one-line "landed +
  verified on main @ b734e6d" marker to that section's header).
- **4b-i reconciliation (against actual code):** the template-mask spoke is
  already on canonical URLs — `ProcessingControls.tsx:85` POSTs
  `POST /api/jobs/:jobId/template-mask/apply` and `template-mask-spoke.tsx:47`
  reads `GET /api/jobs/:jobId/frames/0`. Record 4b-i as "template-mask spoke
  apply trigger + frame preview migrated to canonical." (No 4b-i section exists
  in CLAUDE.md today; add a one-liner so the 4b sub-phase ledger is complete.)

### 4.3 Post-mortem lessons (append to the 4b-0 post-mortem area)

- Re-entrancy is invisible to static analysis; when removing a guard, test the
  newly-reachable second-entry path with first-run residue present.
- Every destructive fs op must log its `path.resolve(...)` target.
- Test persistence in isolation (write → restart/sweep → read) rather than
  inferring it from happy-path runs.
- Don't bake a hypothesis into a diagnostic command (the frame-delete "watch"
  presupposed an immediate delete that never existed).

---

## 5. Verification plan (post-implementation)

1. **`npx tsc --noEmit` → exactly 17 errors** (unchanged baseline).
2. **URL migration (DevTools Network):** approving/deleting a label in the AI
   spoke issues `PATCH|DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId`;
   the label list loads from `GET /api/jobs/:jobId/ai/runs`. No
   `GET /api/videos/:jobId` poll fires from the AI spoke.
3. **AI-without-mask (key new behavior):** upload a job, go STRAIGHT to the AI
   spoke WITHOUT applying any template mask. The spoke must be enterable as soon
   as the job is `ready`, frame 0 renders via the raw fallback, and AI runs
   successfully on raw frames. DevTools Network shows
   `?source=template_mask` → **404** → raw `GET /api/jobs/:jobId/frames/0`
   (no `&v=` param).
4. **Staleness (masked path):** apply mask #1 → AI spoke shows mask #1 → delete
   the run → apply a *different* mask #2 → AI spoke shows **mask #2** (no hard
   reload needed). Confirm the masked request URL carries `&v=<completedAt>`.
5. **No regression:** raw frames still serve (raw fallback unchanged); the
   `applyPaths` tripwire test stays green
   (`npx tsx server/services/__tests__/applyPaths.test.ts`); template-mask spoke
   apply still works.

---

## 6. Deliverable after approval

Implement the above frontend changes in `ai-spoke.tsx`, apply the CLAUDE.md
edits, run the verification, and write `docs/refactor/PHASE_4B_II_REPORT.md`.

**Awaiting approval before editing any code.**
