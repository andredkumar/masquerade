# Phase 4d-1b Proposal — migrate the two surviving legacy status polls (audit-gap fix)

**Status: PROPOSAL — awaiting approval. No code written yet.**

A targeted follow-up to 4d-1. A live server-log check on a fresh job caught
`GET /api/videos/:jobId` firing every ~2s from the **canonical** app. The 4d-1 static
audit missed it because the URL is built from a react-query **queryKey array**
(`['/api/videos', jobId]`), where the slash-join happens at runtime — my 4d-1 grep used the
literal-slash pattern `/api/videos/` and never matched the array form. This proposal migrates
the two canonical-app polls and re-audits with **non-slash-aware** greps.

Constraints honored: REMOVE NOTHING on the backend (no alias/route/home.tsx removal — still
reversible 4d-1 territory); migrate ONLY the two canonical-app polls; leave `home.tsx`; do not
touch the b734e6d re-entrancy fix, applyPaths, tripwire, or retention; `npx tsc --noEmit` stays
at exactly **17**; frontend-only.

---

## 0. Backend verification (why these migrations are safe — read-only, no backend change)

Confirmed by reading `server/services/videoProcessor.ts` that on template-mask **apply
completion** (lines 403–427) the backend does all three of:

1. `updateVideoJob(jobId, { status: 'completed', progress: 100, completedAt })` — legacy `VideoJob`.
2. `setTemplateMaskState(jobId, { status: 'complete', …, completedAt })` — **V2 `Job.templateMask`**.
3. `updateProgress(jobId, { stage: 'completed', progress: 100 })` → `io.emit('progress', { jobId, … })`
   (videoProcessor.ts:1081).

On **failure** (lines 435–458) the same three fire with `status: 'failed'` / `stage: 'failed'`.

Implications:

- The V2 `Job.templateMask.status` transitions to `'complete'` / `'failed'` at the **same moment**
  legacy `VideoJob.status` becomes `'completed'` / `'failed'`. The terminal signal these polls
  watch for exists on the V2 Job.
- A WebSocket `'progress'` event fires at that moment. **`JobContext` already refetches
  `GET /api/jobs/:jobId` on every `'progress'` event** (`JobContext.tsx:50–63`), so
  `useJob().job.templateMask.status` updates live — **no separate 2s poll is needed** to learn the
  job finished.
- `Job.templateMask.completedAt` is populated on completion (the timestamp ProcessingStatus
  displays).

No backend change is required for 4d-1b. (This section is read-only evidence, not a code change.)

---

## 1. Shape difference being handled

| | Legacy `GET /api/videos/:jobId` | Canonical `GET /api/jobs/:jobId` (V2 `Job`) |
|---|---|---|
| Wrapper | `{ job: VideoJob, progress?: ProcessingProgress }` | the `Job` record **directly** (no wrapper) |
| Terminal status field | `job.status === 'completed' \| 'failed'` (whole-job enum) | `job.templateMask?.status === 'complete' \| 'failed'` (spoke enum) |
| Completion time | `job.completedAt` | `job.templateMask?.completedAt` |
| Granular progress | `progress` (ProcessingProgress: stage/currentFrame/totalFrames/%) | **not present on `Job`** — only via WebSocket `'progress'` |

Note the enum word differs: legacy `'completed'` vs V2 spoke `'complete'`. Both components must
read the **`templateMask` spoke** status, not the top-level `Job.status` (which is
`'extracting' | 'ready' | 'failed'` — the *source/extraction* status, unrelated to apply).

---

## 2. Callsite #1 — `client/src/components/ProcessingStatus.tsx:24`

**Current** (line 23–27):
```ts
const { data: jobData } = useQuery({
  queryKey: ['/api/videos', jobId],
  refetchInterval: 2000,
  enabled: !!jobId
});
```
Reads from `jobData`:
- `(jobData as any)?.progress` → fallback for `currentProgress` (line 48; **WebSocket `progress` is
  primary**: `progress || jobData?.progress`).
- `(jobData as any)?.job` → `job` (line 49); used for `job.status` (display line 188; Download-button
  gate lines 213, 220) and `job.completedAt` (display lines 190–192).

### Decision: Option B (switch queryKey), NOT Option A (`useJob()`)

The kickoff asks to PREFER `useJob()` *if the component already has access*. **It does not, and it
cannot here** — ProcessingStatus is rendered in **two** places:

- `template-mask-spoke.tsx:263` — inside `<JobProvider>` ✓
- `home.tsx:651` — **home.tsx has no `JobProvider`** (legacy linear page; dies in 4d-2).

Making ProcessingStatus call `useJob()` would throw *"useJob must be used within a `<JobProvider>`"*
in home.tsx, breaking the legacy page before 4d-2 is allowed to remove it. So Option A is rejected;
ProcessingStatus stays self-contained and switches its own poll to the canonical URL.

### Proposed change
```ts
const { data: jobData } = useQuery<Job>({
  queryKey: ['/api/jobs', jobId],   // canonical: GET /api/jobs/:jobId (V2 Job, no wrapper)
  refetchInterval: 2000,
  enabled: !!jobId
});
```
Then adapt the three reads to the V2 `Job` shape (the response is the `Job` directly, so drop the
`.job` / `.progress` unwrap):
- `currentProgress` fallback: V2 `Job` has no `progress`, so drop the poll fallback and rely on the
  WebSocket `progress` state the component already maintains (`useWebSocket()` + `setProgress`,
  lines 20/35–38). `const currentProgress = progress;`
- Completion gate / display: read the **templateMask spoke**:
  - `const tm = (jobData as Job | undefined)?.templateMask;`
  - replace `job?.status === 'completed'` (lines 213, 220) with `tm?.status === 'complete'`
  - replace `job?.status` display (line 188) with `tm?.status ?? 'unknown'`
  - replace `job?.completedAt` (lines 190–192) with `tm?.completedAt`

This keeps the 2s `refetchInterval` (the kickoff's fallback path — "switch the queryKey to
`['/api/jobs', jobId]`"). The poll is **not** removed for this component because it has no
`useJob()`/Socket-driven refetch of its own for the Job record; its WebSocket only carries
`progress`, not the spoke terminal status.

### FLAG — minor, intentional behavior change
- **Lost pre-first-event progress fallback (cosmetic):** the granular `progress` previously came from
  the poll as a fallback before the first WebSocket `progress` event. V2 `Job` carries no granular
  progress, so on first paint (before the first WS event) the bar shows 0% momentarily instead of the
  polled value. WebSocket remains the live source thereafter; no functional loss. **Flagged, not
  silently dropped** — if undesired we keep a canonical progress source, but none exists on `Job`
  today and the kickoff said frontend-only unless genuinely needed.
- **Cross-page note:** this change also moves the home.tsx-rendered ProcessingStatus instance to the
  canonical URL. That is safe — `GET /api/jobs/:jobId` returns a valid `Job` for any job, and
  `Job.templateMask` is dual-written by the same `videoProcessor` regardless of which page started the
  apply (videoProcessor.ts:413). home.tsx keeps working until 4d-2 deletes it.

---

## 3. Callsite #2 — `client/src/pages/template-mask-spoke.tsx:89`

**Current** (lines 88–100):
```ts
const { data: legacyJobData } = useQuery({
  queryKey: ["/api/videos", jobId],
  refetchInterval: 2000,
  enabled: !!jobId,
});
const legacyJob = (legacyJobData as any)?.job;
useEffect(() => {
  if (legacyJob && isProcessing && (legacyJob.status === "completed" || legacyJob.status === "failed")) {
    setIsProcessing(false);
  }
}, [legacyJob, isProcessing]);
```
The poll exists **only** to clear the local `isProcessing` banner when apply finishes.

### Decision: Option A — remove the poll, use `useJob()` (already in scope)

This component already calls `const { job, refetch } = useJob();` (line 16). Per §0, `job.templateMask.status`
transitions to `complete`/`failed` and JobContext refetches live on the WS `progress` event. The
separate 2s `['/api/videos', jobId]` poll is **fully redundant and removable**.

### Proposed change
Delete the `useQuery` block and `legacyJob`, and rewrite the effect to watch the V2 spoke status:
```ts
useEffect(() => {
  const tmStatus = job?.templateMask?.status;
  if (isProcessing && (tmStatus === "complete" || tmStatus === "failed")) {
    setIsProcessing(false);
  }
}, [job?.templateMask?.status, isProcessing]);
```
Also remove the now-unused `useQuery` import if nothing else in the file uses it (it does not — grep
confirms `useQuery` appears only at this callsite). This deletes the legacy constructor entirely
rather than re-pointing it.

> On "REMOVE NOTHING": that constraint is about backend aliases/routes/home.tsx (reversibility of the
> one-way door). Removing this **redundant client-side poll** is exactly the "the separate 2s poll may
> be fully removable" outcome the kickoff invited, and is fully reversible (frontend only).

### FLAG
- None. The banner-clear semantics are preserved 1:1 (`complete`/`failed` ⇔ legacy
  `completed`/`failed`), and JobContext's WS-driven refetch is at least as timely as the old 2s poll.

---

## 4. Non-slash-aware re-audit (the gap the 4d-1 audit missed)

Greps run across `client/src` in **all** forms — literal-slash, non-slash, quoted, and queryKey-array.

### 4.1 `GET /api/videos/:jobId` (the status poll) — every dynamic form

`grep "queryKey:\s*\["` (the missed array form) → **exactly three**, all `/api/videos`:

| Callsite | Form | Verdict |
|---|---|---|
| `ProcessingStatus.tsx:24` | `queryKey: ['/api/videos', jobId]` | **MIGRATE** → `['/api/jobs', jobId]` (§2) |
| `template-mask-spoke.tsx:89` | `queryKey: ["/api/videos", jobId]` | **MIGRATE/REMOVE** → `useJob()` (§3) |
| `home.tsx:57` | `queryKey: ['/api/videos', currentJob]` | **LEAVE** — home.tsx-only, dies in 4d-2 |

No queryKey-array constructor exists for **any other** legacy URL — so no other hidden dynamic poll.
After 4d-1b, the only `/api/videos`-status-poll constructor left is `home.tsx:57` (home-only,
acceptable per the kickoff).

### 4.2 Other `/api/videos` occurrences (non-status-poll) — re-confirmed

`grep "api/videos"`:

| Callsite | Form | Disposition |
|---|---|---|
| `home.tsx:175` | `` `/api/videos/${currentJob}/download…` `` | home.tsx-only → LEAVE (4d-2) |
| `FileUpload.tsx:35` | `'/api/videos/upload'` (POST upload) | **Not** the status poll; the upload endpoint. Out of 4d-1b scope; tracked with FileUpload's own disposition. **Flagging for re-confirmation** rather than asserting. |

### 4.3 Other legacy removal-list URLs — re-confirmed with non-slash greps

`grep "api/ai/infer|api/ai/labels|internal/mask-processing|/overlays/|/masks/"`:

| Legacy URL | Result | Verdict |
|---|---|---|
| `/api/ai/infer` | **0 constructors** in client (migrated to `/api/jobs/${jobId}/ai/runs` in 4d-1 — CommandInput) | clean |
| `/api/ai/labels/:jobId(/...)` | only `home.tsx:118,136,150` | home-only → LEAVE (4d-2) |
| `/internal/mask-processing` | 0 in client (backend-internal) | clean |
| `/overlays/` | only `FrameViewer.tsx:232` — the **canonical** `/api/jobs/${jobId}/ai/runs/${runId}/overlays/…` form (4d-1) | not legacy ✓ |
| `/masks/` | 0 non-canonical constructors | clean |

**Re-audit conclusion:** the only dynamic constructors of `GET /api/videos/:jobId` were the three
queryKey-array forms; two are migrated/removed by 4d-1b, the third is home.tsx-only. No other legacy
URL hides a dynamic (array/concat) constructor in the canonical app.

---

## 5. Verification plan

- `npx tsc --noEmit` → must remain **exactly 17** (10 frameExtractor.ts + 7 maskWorker.ts).
- Re-run the four re-audit greps above; confirm zero canonical-app `/api/videos` status-poll
  constructors remain (home.tsx-only acceptable).
- **Mandatory post-deploy live re-check (the real gate for 4d-2)** — on a FRESH job after a hard
  refresh, per the kickoff:
  - `pm2 logs masquerade --lines 40 --nostream | grep "/api/videos/"` → newest timestamp is OLD (no
    new hits during the fresh canonical-app session).
  - `pm2 logs masquerade --lines 40 --nostream | grep "/api/jobs/"` → shows `GET /api/jobs/:jobId` on
    the ~2s cadence (ProcessingStatus) plus the JobContext refetches.
  - broader sweep: `… grep -E "/api/videos/|/api/ai/infer|/api/ai/labels/|/internal/mask-processing"`
    and `… grep -E "/overlays/|/masks/" | grep -v "/ai/runs/"` → empty during canonical-app use.

---

## 6. Deliverables

1. **This proposal** — `docs/refactor/PHASE_4D1B_PROPOSAL.md`. **Await approval before any code.**
2. After approval: implement §2 + §3, keep tsc at 17, update `CLAUDE.md` (record 4d-1b; the audit-gap
   root cause — queryKey-array URLs missed by literal-slash grep — as a lesson; update the
   `GET /api/videos/:jobId` audit row to "zero canonical-app constructors"), then write
   `docs/refactor/PHASE_4D1B_REPORT.md` with the updated audit table.

---

## 7. Summary of decisions for review

- [ ] **#1 ProcessingStatus.tsx:24** → switch queryKey to `['/api/jobs', jobId]` (Option B). `useJob()`
      rejected because home.tsx renders ProcessingStatus with no `JobProvider`. Reads remapped to
      `Job.templateMask.{status==='complete'|'failed', completedAt}`; progress now WS-only.
      **FLAG:** loses pre-first-WS-event progress fallback (cosmetic).
- [ ] **#2 template-mask-spoke.tsx:89** → **remove** the redundant poll; drive `setIsProcessing(false)`
      off `useJob().job.templateMask.status` (Option A). No flag.
- [ ] **Re-audit:** only 3 queryKey-array `/api/videos` constructors existed; #1/#2 migrated, home.tsx
      left. No other legacy URL has a hidden dynamic constructor. `/api/videos/upload` (FileUpload:35)
      flagged as a separate, non-status-poll endpoint.
- [ ] tsc stays 17; backend untouched; frontend-only.
