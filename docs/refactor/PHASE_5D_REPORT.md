# Phase 5D Report — Fix the Upload→Hub Loading-Hang (frontend room-join)

**Type:** Frontend-only fix (Option 2, per `PHASE_5D_PROPOSAL.md` + `PHASE_5D_AMENDMENT.md`).
One file touched. No backend / status / schema change.

**Status:** Code landed and `tsc`-clean at the 17 baseline. Awaiting the operator's
browser verification on the live Postgres app (§5).

---

## 1. Root cause (confirmed by trace, not the original hypothesis)

The hub hung on "loading" after upload until a hard refresh. The trace (full detail in
`PHASE_5D_PROPOSAL.md`) established:

- **The backend was always correct.** Both facets are created eagerly at upload
  (`routes.ts:162/167`, `:241/246`, `:365/368`), extraction completion writes through
  `updateVideoJob` (`videoProcessor.ts:1182`), which fires the status mirror
  (`storage.ts:135-144` / `pgStorage.ts:112-117`) mapping `ready → ready` into the
  existing Job facet. So `job_status = ready` at completion on **both** MemStorage and
  PgStorage. That is *why* a hard refresh worked — a fresh `GET /api/jobs/:jobId`
  (`routes.ts:418-433`) read the already-correct value.
- **The defect was in the hub's data source.** `client/src/contexts/JobContext.tsx`
  opened its own Socket.IO connection and listened for `progress`, but **never emitted
  `socket.emit('join', jobId)`**. The server emits progress room-scoped
  (`io.to(jobId)`, `videoProcessor.ts:1084`; join handler `routes.ts:1181-1182`). So the
  hub's socket was never in the room, received zero `progress` events, and never
  refetched past its initial `extracting` snapshot. Corroborated by the two working
  consumers that *do* join (`ProcessingStatus.tsx:34`, `CommandInput.tsx:123`) —
  JobContext was the lone anomaly.
- The earlier `storage.ts:129-140` hypothesis (recorded in `CLAUDE.md`) was written from
  the symptom and is **false**; the mirror works correctly. `CLAUDE.md` is corrected as
  part of this phase.

### Why this became a live bug at 5B (history, so it isn't misread later)

This defect was, in effect, **exposed by 5B** — not introduced as a regression. Before
5B, progress was a global broadcast (`io.emit`): every socket received every event
regardless of room membership, so JobContext's missing `join` was harmless (it got
progress anyway). 5B correctly scoped emits to `io.to(jobId)` to stop cross-job progress
leakage — the right change. That turned JobContext's latent missing-join into a live
hang. 5D closes that pre-existing latent defect; it does **not** undo 5B's correct
room-scoping.

---

## 2. The fix

**File touched:** `client/src/contexts/JobContext.tsx` (only). Net: the manual
`fetch` + `useState` data path was replaced with the codebase's existing React Query
pattern, plus the room-join. Rough line count: ~55 → ~85 lines (one file).

Three parts, all contained to the hub's data path:

1. **Core: join the room.** Inside the socket effect, `socket.emit('join', jobId)` so
   JobContext enters the room the `progress` emits are scoped to, and refetches on
   matching `progress` events (which it already listened for). Mirrors
   `ProcessingStatus.tsx`.
2. **Reconnect-safe re-join (required hardening).** `socket.on('connect', join)` re-emits
   `join` on every (re)connect, so a reconnect or a navigate-away/return re-enters the
   room. This also covers the disconnect-at-completion race for free.
3. **Bounded self-heal refetch (required hardening).** The read uses `useQuery` with a
   bounded `refetchInterval` — polls every 2 s **only while** the status is not terminal
   and **stops** once `ready` or `failed`. This reuses ProcessingStatus's existing
   `refetchInterval` mechanism (React Query) rather than a novel one, and self-heals a
   missed/late `progress` emit so the hub can never hang indefinitely.

**Interface preserved.** `useJob()` still returns `{ job, isLoading, error, refetch }`;
all three consumers (`hub.tsx`, `template-mask-spoke.tsx`, `ai-spoke.tsx`) are
unchanged. The read reuses the app's default queryFn (`lib/queryClient.ts:49-64`, which
resolves `['/api/jobs', jobId]` → `GET /api/jobs/:jobId`), so no new fetching mechanism
was invented. The two prior error strings ("Job not found" on 404, "Failed to load job"
otherwise) are preserved via a small mapper.

**One deliberate robustness change:** an error is now surfaced only when there is **no**
job to show (`isError && !data`). A transient background-poll blip mid-extraction no
longer flips a working hub to the error screen — the old manual path nulled the job on
any refetch error, which was itself fragile. Noted here for transparency.

**Not touched:** `useWebSocket` (unchanged), the other socket consumers, and the entire
backend.

---

## 3. `tsc` = 17 (unchanged)

Baseline held exactly: 10 in `server/services/frameExtractor.ts` + 7 in
`server/services/maskWorker.ts`, **zero** in `JobContext.tsx` or any touched file. Run
from inside `masquerade-aws-latest` (the repo root has no tsconfig):

```
npx tsc --noEmit   → 17 errors, all pre-existing (frameExtractor.ts, maskWorker.ts)
```

---

## 4. Blast radius (as accepted in the amendment §3)

- **Frontend-only.** No change to `storage.ts`, `pgStorage.ts`, schema, the status
  mirror, or `processVideo`. The A3 two-status-column model (`video_status` /
  `job_status`) and its derivation are untouched.
- **Conformance suite:** unaffected — no backend line changed, so no re-run against RDS
  is required (per the proposal / amendment).
- **PgStorage == MemStorage:** moot for this fix — both already produced correct
  `job_status = ready`; the change is entirely client-side.
- **`tsc` stays 17.** No scope creep into Phase 6 or the backlog.

---

## 5. Browser verification (operator, on the live Postgres app)

1. **Core success criterion:** upload a video → wait for extraction to finish → **the hub
   transitions to ready on its own, no hard refresh** → the Template Mask / Run AI spokes
   enable automatically.
2. **Reconnect / navigation robustness:** start an upload, navigate away from the hub
   mid-extraction, navigate back → the hub still reaches ready without a manual refresh
   (exercises the re-join-on-(re)connect path).
3. **Self-heal:** even if a single `progress` emit is missed, the hub reaches ready
   within the ~2 s poll window rather than hanging; polling then stops at the terminal
   status.
4. **Secondary data check (already true at the source):** `GET /api/jobs/:jobId` (or a
   `job_status` DB query) shows `ready` for a completed job — confirming the fix makes the
   UI observe correct data live, not paper over anything.

---

## 6. Files touched

| File | Change |
|------|--------|
| `client/src/contexts/JobContext.tsx` | The fix: room-join + reconnect-safe re-join + bounded React Query self-heal poll; interface + error strings preserved. |
| `docs/refactor/PHASE_5D_PROPOSAL.md` | New (prior step) — the trace + approved plan. |
| `docs/refactor/PHASE_5D_REPORT.md` | New — this file. |
| `CLAUDE.md` | Corrected 5D root cause (was the false `storage.ts:129-140` hypothesis) → actual missing-`join`; noted the 5B-exposed-latent-defect history; 5D + Phase 5 marked complete. |

On operator-confirmed browser verification, this closes **5D** and **Phase 5 in full**
(5A, 5B, 5C-1, 5C-2, 5D).
