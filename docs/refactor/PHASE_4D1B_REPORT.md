# Phase 4d-1b Report — two queryKey-array status polls migrated (audit-gap fix)

**Status: IMPLEMENTED. Frontend-only; backend untouched. tsc = 17.**
**The mandatory live re-check on a fresh job (see §5) is the gate for 4d-2 — not yet run here.**

Follows `PHASE_4D1B_PROPOSAL.md` (approved as written). The 4d-1 static audit's literal-slash grep
(`/api/videos/`) missed two canonical-app components that build `GET /api/videos/:jobId` from a
react-query **queryKey array** (`['/api/videos', jobId]`, joined at runtime). A live
`pm2 logs masquerade | grep "/api/videos/"` on a fresh job caught the poll firing every 2s — a real
4d-2 blocker. Both are now migrated to the canonical V2 Job endpoint.

---

## 1. Changes implemented

### 1.1 `client/src/components/ProcessingStatus.tsx` — switch queryKey to canonical (Option B)

`useJob()` was **rejected** because ProcessingStatus is also rendered by `home.tsx:651`, which has no
`<JobProvider>` — `useJob()` would throw and break the legacy page before 4d-2 deletes it. So the
component keeps its own poll but points it at the canonical URL and reads the V2 `Job` shape.

- Import: added `Job` to the `@shared/schema` type import.
- Query (line 24): `queryKey: ['/api/videos', jobId]` → `queryKey: ['/api/jobs', jobId]`, typed
  `useQuery<Job>`. The response is the `Job` record directly (no `{ job, progress }` wrapper).
- Derivations:
  - `const currentProgress = progress;` — WebSocket-only now (V2 `Job` has no granular `progress`).
  - `const job = jobData;` (V2 `Job`), `const tm = job?.templateMask;`, `const completedAt = tm?.completedAt;`
- Reads remapped to the **templateMask spoke**:
  - status display: `job?.status || 'unknown'` → `tm?.status ?? 'unknown'`
  - completion timestamp: `job?.completedAt` / `job.completedAt` → `completedAt`
  - Download-button + "completed successfully" gate (×2): `job?.status === 'completed'` →
    `tm?.status === 'complete'`
- Untouched: the loading guard `if (!currentProgress && !job)` still works (`job` = the V2 record,
  present once the canonical fetch returns); `currentProgress?.stage === 'completed'` at the status
  dot is the WebSocket `ProcessingProgress.stage` enum — correctly left alone.

### 1.2 `client/src/pages/template-mask-spoke.tsx` — remove the redundant poll (Option A)

The poll existed only to clear the local `isProcessing` banner. The component already has `useJob()`,
and `JobContext` refetches the V2 `Job` on the WebSocket `'progress'` event that fires at apply
completion/failure — so the separate 2s poll was fully redundant.

- Removed the `useQuery({ queryKey: ['/api/videos', jobId], … })` block and the `legacyJob` derivation.
- Rewrote the effect to key off the canonical spoke status:
  ```ts
  useEffect(() => {
    const tmStatus = job?.templateMask?.status;
    if (isProcessing && (tmStatus === "complete" || tmStatus === "failed")) {
      setIsProcessing(false);
    }
  }, [job?.templateMask?.status, isProcessing]);
  ```
- Removed the now-unused `import { useQuery } from "@tanstack/react-query";`.

> "REMOVE NOTHING" (the 4d-1 constraint) is about backend aliases/routes/home.tsx — the one-way door.
> Deleting this redundant **client-side** poll is fully reversible (frontend only) and is the
> "the separate 2s poll may be fully removable" outcome the kickoff invited.

---

## 2. Backend evidence (read-only; no backend change made)

`server/services/videoProcessor.ts`, on template-mask apply:

- **Completion (lines 403–427):** `updateVideoJob({status:'completed',progress:100,completedAt})`
  **and** `setTemplateMaskState({status:'complete',…,completedAt})` **and**
  `updateProgress({stage:'completed',progress:100})` → `io.emit('progress', {jobId,…})` (line 1081).
- **Failure (lines 435–458):** the same three with `status:'failed'` / `stage:'failed'`.

So the V2 `Job.templateMask.status` reaches `complete`/`failed` at the same instant legacy
`VideoJob.status` reaches `completed`/`failed`, a WS `'progress'` event fires, and `JobContext`
(`JobContext.tsx:50–63`) refetches `GET /api/jobs/:jobId` on it. Both migrations are semantically
equivalent to the polls they replace.

---

## 3. Updated audit table — `GET /api/videos/:jobId` and re-confirm of other legacy URLs

Non-slash-aware greps over `client/src` (the method the 4d-1 audit lacked):

### 3.1 Every dynamic constructor of the status poll — `grep "queryKey:\s*\["`

| Callsite | Form | Pre-4d-1b | Post-4d-1b |
|---|---|---|---|
| `ProcessingStatus.tsx:24` | `queryKey: ['/api/videos', jobId]` | LIVE legacy poll (missed by 4d-1) | **`['/api/jobs', jobId]`** ✓ |
| `template-mask-spoke.tsx:89` | `queryKey: ["/api/videos", jobId]` | LIVE legacy poll (missed by 4d-1) | **removed** (drives off `useJob()`) ✓ |
| `home.tsx:57` | `queryKey: ['/api/videos', currentJob]` | home-only | **LEFT** (dies in 4d-2) |

Only **three** queryKey-array `/api/videos` constructors ever existed; no queryKey-array constructor
exists for any other legacy URL. **Post-4d-1b canonical-app constructors of `GET /api/videos/:jobId`:
zero.** Remaining: `home.tsx:57` only (home-only — acceptable per the kickoff).

### 3.2 Other `/api/videos` occurrences — `grep "api/videos"`

| Callsite | Form | Disposition |
|---|---|---|
| `home.tsx:175` | `` `/api/videos/${currentJob}/download…` `` | home-only → 4d-2 |
| `FileUpload.tsx:35` | `'/api/videos/upload'` (POST upload) | **not** the status poll; upload endpoint, tracked separately. FLAGGED for re-confirm, not asserted. |

### 3.3 Other legacy removal-list URLs — re-confirmed with non-slash greps

| Legacy URL | Result | Verdict |
|---|---|---|
| `/api/ai/infer` | 0 client constructors (4d-1 migrated CommandInput → `/api/jobs/${jobId}/ai/runs`) | clean |
| `/api/ai/labels/:jobId(/…)` | only `home.tsx:118,136,150` | home-only → 4d-2 |
| `/internal/mask-processing` | 0 in client | clean |
| `/overlays/` | only `FrameViewer.tsx:232` — the canonical `/api/jobs/${jobId}/ai/runs/${runId}/overlays/…` (4d-1) | not legacy ✓ |
| `/masks/` | 0 non-canonical constructors | clean |

**Conclusion:** the only dynamic constructors of `GET /api/videos/:jobId` were the three
queryKey-array forms; two migrated/removed, the third home-only. No other legacy URL hides a
dynamic (array/concat) constructor in the canonical app.

---

## 4. Verification done here

- `npx tsc --noEmit` → **exactly 17** errors (10 `frameExtractor.ts` + 7 `maskWorker.ts`); zero new.
- All re-audit greps in §3 re-run and confirmed.
- `CLAUDE.md` updated: new "Phase 4d-1b landed" section; the superseded 4d-1 audit claim annotated;
  the audit-gap LESSON recorded (literal grep misses dynamic URLs → must use non-slash/array greps +
  a live check before any irreversible removal); the `GET /api/videos/:jobId` URL-table row updated;
  the cosmetic first-paint-progress item logged as a future "canonical progress source" polish item,
  not a blocker.

---

## 5. MANDATORY live re-check on a FRESH job — the authoritative 4d-2 gate (NOT yet run)

Static re-audit is necessary but not sufficient (it's what missed this). After deploy, on a FRESH
job after a hard refresh, open the template-mask spoke, let it sit ~20s, then:

```
pm2 logs masquerade --lines 40 --nostream | grep "/api/videos/"
```
- **PASS = newest timestamp is OLD** (no new `/api/videos/:jobId` hits during the fresh
  canonical-app session). The canonical app no longer polls the legacy URL.

Confirm the canonical poll IS happening instead:
```
pm2 logs masquerade --lines 40 --nostream | grep "/api/jobs/" | tail
```
- should show `GET /api/jobs/:jobId` on the ~2s cadence (ProcessingStatus) plus JobContext refetches.

Broader sweep during a full workflow:
```
pm2 logs masquerade --lines 500 --nostream | grep -E "/api/videos/|/api/ai/infer|/api/ai/labels/|/internal/mask-processing"
pm2 logs masquerade --lines 500 --nostream | grep -E "/overlays/|/masks/" | grep -v "/ai/runs/"
```
- **Both empty during canonical-app use = the live gate is GREEN.**

**Only when this live re-check is clean does 4d-2 proceed.**

---

## 6. Behavior-change flag (carried forward)

- **ProcessingStatus first-paint progress (cosmetic, accepted):** the V2 `Job` record carries no
  granular `progress`; it is WebSocket-only. Before the first `'progress'` event the bar may read 0%
  for a beat (previously the legacy poll supplied a fallback). No functional loss — WS is the live
  source thereafter. Logged in `CLAUDE.md` as a future "canonical progress source" polish item.
