# Phase 5D Proposal — Fix the Upload→Hub Loading-Hang

**Type:** Root-cause confirmation + minimal-fix proposal. Proposal only — no code
changed yet, awaiting green-light.

**Headline (read this first):** The kickoff's Option-1 premise does **not** hold
against current source. `Job.status` / `job_status` is **already `ready` at the
source** when extraction completes — on both MemStorage and live PgStorage. There is
no backend data bug to fix. The hang is a **frontend** defect: the hub's data source
(`JobContext`) never joins the Socket.IO room, so it never receives the `progress`
signal that would tell it to refetch. **The §0.4 fallback is therefore RAISED: we go
with Option 2 (frontend reacts to the real ready signal).** Details and evidence below.

---

## 1. Root cause confirmed against current source (kickoff §0.1)

I traced the full upload → extraction-completion → hub-read path. The mechanism is
**not** what the kickoff diagnosis assumed. Here is the actual chain, with line refs.

### 1a. Both facets are created eagerly at upload — the Job facet already exists

On every upload path the server creates **both** the legacy VideoJob facet and the V2
Job facet up front, both at `status: 'extracting'`:

- `server/routes.ts:162` `createVideoJob(...)` + `routes.ts:167` `createJobV2({... status:'extracting' ...})` (DICOM path)
- `server/routes.ts:241` `createVideoJob(...)` + `routes.ts:246` `createJobV2({... status:'extracting' ...})` (standard video path)
- `server/routes.ts:365` / `:368` (third path) — same shape

So by the time extraction runs, **`job_status` (the Job facet) is already present** —
which is exactly the precondition the status mirror requires.

### 1b. Extraction completion routes through `updateVideoJob` — the mirror fires

Background extraction completes in `startBackgroundFrameExtraction`:

- `server/services/videoProcessor.ts:1179` logs `BACKGROUND EXTRACTION COMPLETE`
- `server/services/videoProcessor.ts:1182` `await storage.updateVideoJob(jobId, { status: 'ready' })`

That call goes through the status mirror:

- **MemStorage** `server/storage.ts:135-144`: `updates.status` is truthy →
  `mapVideoJobStatusToJobStatus('ready')` → `'ready'` → Job facet exists
  (`jobsV2.get(id)` present) → `jobV2.status = 'ready'`.
- **PgStorage** `server/pgStorage.ts:112-117`: identical semantics —
  `mapVideoJobStatusToJobStatus('ready')` → `'ready'` and `row.jobStatus != null`
  (facet exists) → `set.jobStatus = 'ready'` → persisted via
  `db.update(jobs).set(set)`.

The mapping is `ready → ready` (`server/storage.ts:33-37`), so the mirror maps to a
value the hub treats as ready.

### 1c. The hub reads `job.status` from the V2 Job — which is now `ready`

- `GET /api/jobs/:jobId` → `getJobV2Handler` (`server/routes.ts:418-433`) →
  `storage.getJobV2(jobId)` returns the canonical V2 Job.
- Hub (`client/src/pages/hub.tsx`) reads `job.status` via `useJob()`;
  `isReady = job.status === "ready"`.

**Conclusion:** after completion, a fresh `GET /api/jobs/:jobId` returns
`status: "ready"`. That is precisely why a **hard refresh works** — it re-issues the
HTTP fetch and reads the already-correct `ready`. The data is correct at the source.

---

## 2. Which of case (a) / (b) is true? — **NEITHER** (kickoff §0.2)

The kickoff asked me to distinguish two source-side failure modes. Traced against the
code, **neither is the mechanism**:

- **Case (a)** — "completion path doesn't go through `updateVideoJob`, bypassing the
  mirror." **False.** Completion is `videoProcessor.ts:1182`, which *is*
  `storage.updateVideoJob(...)`. The mirror is on that path and it fires.
- **Case (b)** — "completion calls `updateVideoJob`, but the mirror maps
  `ready`→something not-ready, or the hub reads a different field." **False.** The
  mapping is `ready → ready` (`storage.ts:33-37`) and the hub reads `job.status`
  (`hub.tsx`), the exact field the mirror writes.

Both (a) and (b) presuppose a **backend** data bug. There isn't one. The backend
produces correct `job_status = ready` at completion on both storages.

### The actual root cause — a missing room-join on the frontend

`client/src/contexts/JobContext.tsx` is the hub's data source. It:

1. Opens its **own** Socket.IO connection via `useWebSocket()`
   (`JobContext.tsx:18`). Critically, `useWebSocket` (`client/src/hooks/useWebSocket.ts:8-36`)
   creates a **fresh, independent socket per hook instance** (`io()` inside a
   `useEffect(..., [])`, stored in a per-instance `socketRef`). Every consumer gets
   its own socket id and its own room memberships.
2. Does an initial `fetch('/api/jobs/:id')` → gets the `extracting` snapshot
   (`JobContext.tsx:44-47`).
3. Refetches **only** on a `'progress'` event whose `data.jobId === jobId`
   (`JobContext.tsx:50-63`).
4. **Never emits `socket.emit('join', jobId)`.**

Meanwhile the server emits progress **room-scoped**:
`this.io.to(jobId).emit('progress', ...)` (`videoProcessor.ts:1084`), and a client only
enters that room by emitting `join` (server handler `routes.ts:1181-1182`
`socket.on('join', jobId => socket.join(jobId))`).

So JobContext's socket is **never in room `jobId`** → receives **zero** `progress`
events → step 3 never fires → the hub stays on its initial `extracting` snapshot until
a hard refresh re-runs step 2. That is the hang.

**Corroboration from the same codebase:** the two components that *do* update live —
`ProcessingStatus.tsx:34` and `CommandInput.tsx:123` — both emit `socket.emit('join', jobId)`.
`ProcessingStatus` additionally runs a 2 s React-Query poll
(`refetchInterval: 2000`, `ProcessingStatus.tsx:26`). JobContext has **neither** the
join nor a poll — it is the lone anomaly that depends entirely on a push it can never
receive.

---

## 3. Secondary candidate (Socket.IO disconnect at EXTRACTION COMPLETE) — RULED OUT as the hub's cause (kickoff §1)

The `CLAUDE.md` 5D note flagged logs showing `Client disconnected` right at
`EXTRACTION COMPLETE`. Ruling: **not the hub's primary cause.** JobContext's socket
never joined the room, so even a perfectly stable, never-disconnecting connection would
deliver it nothing. The disconnect is a red herring for the hub — most likely a
short-lived sibling socket (upload page / ProcessingStatus / CommandInput unmounting on
navigation) closing. It does not explain, and is not required to explain, the hang. If
we add a reconnect-safe join (§4), any disconnect race is covered for free.

---

## 4. Proposed minimal fix — Option 2, frontend only (kickoff §0.4 fallback)

Because the source is already correct (§1), **Option 1 is inapplicable** — there is no
source-side status write to add; `job_status` is already `ready`. Adding a redundant
backend write would be a no-op against a value that is already right. Per kickoff §0.4,
I am **flagging this and recommending Option 2**: make the hub react to the real ready
signal.

**The fix (one file, `client/src/contexts/JobContext.tsx`):** have JobContext join the
job room so it receives the room-scoped `progress` emits it already listens for —
mirroring the established `ProcessingStatus.tsx:31-47` pattern. Concretely, inside the
existing socket `useEffect` (or a sibling one gated on `[socket, jobId]`):

```ts
if (!socket) return;
socket.emit('join', jobId);      // ← the missing line; enter room `jobId`
// (existing) socket.on('progress', handleProgress) → refetch on match
```

Re-emitting `join` whenever `socket` transitions to connected also closes the
disconnect-at-completion race (§3): on reconnect the client re-joins and the next
refetch pulls the now-`ready` record.

**Optional hardening (recommend, still frontend-only):** add a bounded refetch
fallback so the hub self-heals even if a single `progress` emit is missed — either a
short `refetchInterval`-style poll while `!isReady` (as `ProcessingStatus` already
does), or a one-shot refetch on socket `connect`. This is defense-in-depth, not
required for the core fix. I'll propose the exact form at implementation time; the
join alone satisfies the §5 success criterion.

**Reuse of `mapVideoJobStatusToJobStatus`:** not applicable — the fix touches no
mapping. The mapping already produces the correct `ready` on the backend; we simply let
the frontend observe it.

---

## 5. Blast-radius confirmation — REQUIRED gate (kickoff §0.3, §2)

The proposed fix is **frontend-only** and touches **zero** backend/status code.

| Constraint | Status under this fix |
|---|---|
| A3 two status columns (`video_status` / `job_status`) + their derivation | **Untouched.** No change to `storage.ts`, `pgStorage.ts`, schema, or the mirror. |
| Conformance suite status-mirror assertions | **Still hold.** Backend unchanged → suite unaffected. No re-run against RDS required (no status logic changed); I will re-run it anyway if any backend line is touched, but none is planned. |
| `processVideo` / extraction pipeline | **Not modified at all** — not even an additive status write. The production video flow is untouched. |
| "Mirror only when Job facet exists" rule | **Preserved.** Not touched. |
| PgStorage == MemStorage behavior | **Preserved and moot** — both already emit correct `job_status = ready`; the fix is on the client, identical regardless of backend. |
| `tsc` = 17 | **Stays 17.** The change is adding a `socket.emit('join', jobId)` call (and optionally a refetch) in an existing `.tsx`; trivially typed, introduces no new errors. |
| Scope (no Phase 6 / backlog creep) | **Held.** No manifest, serve-static, debug-logging, or Socket.IO-CORS changes. |

**Frontend-change justification (kickoff §2.5):** the kickoff allowed a small hub change
*only if* the hub needs one to consume the now-correct status. It does — the hub was
never joining the room, so it never consumed the push. This is exactly the §2.5
carve-out, called out explicitly here.

---

## 6. Success criterion this fix targets (kickoff §5)

**Upload → wait for extraction → hub transitions to `ready` on its own, no hard
refresh.** With JobContext joining the room, the completion-time `progress` emit
(`stage: 'ready'`, `videoProcessor.ts:1183`) reaches the hub's socket → `handleProgress`
refetches → `GET /api/jobs/:jobId` returns the already-`ready` V2 Job → `isReady`
flips → spokes enable. Secondary check (`job_status = ready` for a completed job in
Postgres) is **already satisfied today** at the source per §1 — this fix makes the UI
observe it live.

---

## 7. Recommendation

Green-light **Option 2 (frontend, `JobContext.tsx` joins the job room)**. It is the
correct and minimal fix: the backend is already right, the defect is a one-line missing
room-join in the hub's data source, and the fix is fully contained to the client with
zero blast radius on the A3 status model or the production video pipeline. On approval I
will implement the join (plus, if you want, the optional refetch hardening), verify in
the browser on the live Postgres app, keep `tsc` at 17, and write
`PHASE_5D_REPORT.md` + the `CLAUDE.md` update (diff first).
