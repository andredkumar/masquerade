# Phase 5B Report — Backend/infra cleanup (Deploy 1)

**Implemented against:** `PHASE_5B_AMENDMENT.md` (which accepts the proposal's
source-verified reconciliations and adds three binding decisions). Shipped as
**one reversible deploy**. `tsc` held at the **17** baseline (10 `frameExtractor.ts`
+ 7 `maskWorker.ts`).

All six sub-stages are backend-only. No client file was touched.

---

## Summary

| Sub-stage | What changed | Reversible? |
|-----------|--------------|-------------|
| 5B-1a | Shared path-traversal guard `resolveWithinRoot` added to `cleanup.ts`; applied at every jobId/runId path boundary in **both** `templateMaskFolderManager.ts` and `applyPaths.ts` (scope expanded per Decision 1). | Yes |
| 5B-1b | Progress broadcast room-scoped: `videoProcessor.ts:1081` `this.io.emit(...)` → `this.io.to(jobId).emit(...)`. | Yes |
| 5B-1d | Debug endpoints `POST /api/test-post` + `POST /test-non-api` deleted from `routes.ts`. | Yes (re-add) |
| 5B-2a | `tempFolderManager.ts` → `templateMaskFolderManager.ts` via `git mv` (history preserved); class name `TempFolderManager` kept; 3 import specifiers updated. | Yes |
| 5B-2b | Two stale `temp_processed/{jobId}/` comments (vp:388, vp:698) corrected to `spokes/template_mask/{jobId}/`. | Yes |
| 5B-2c | `deleteProcessingProgress(jobId)` added to `IStorage` + `MemStorage` + `PgStorage`; folded INTO `deleteVideoJob` per Decision 3. | Yes |

**Dropped/parked (unchanged from amendment):** 5B-1c (dead-code lead — `routes.ts:361`
is LIVE code; left open, needs a corrected ref); 5B-3 (legacy aliases already removed
in 4d-2; doc-only); 5B-4 (`temp_processed/` sweep removal — parked on the runtime
"quiet for several days" gate, unobservable from source).

---

## Files touched (10)

### 1. `server/services/cleanup.ts` — shared validator (Decision 1)

Added `resolveWithinRoot(root, ...segments)` after `safeDelete` (the deletion-boundary
guard), before the `── Public API ──` divider. This is the **single** shared validator;
both consumer modules import it — no copy-paste. `cleanup.ts` is a leaf module (both
`templateMaskFolderManager.ts` and `applyPaths.ts` already imported from it), so no
circular import arises.

It performs the same resolve-and-compare containment check as `safeDelete` but at the
**construction** boundary (before any `mkdir`/write): each segment must be a single
non-empty component (rejects empty/non-string, null byte, `.`, `..`, and `/`/`\`
separators), then `path.resolve(root, ...segments)` must equal the resolved root or be
a true descendant (`startsWith(root + path.sep)`). For a server-generated UUID the
output is byte-identical to `path.join(root, …)` — **no behavior change for valid input**.

### 2. `server/services/applyPaths.ts` (now 146 lines) — guard applied (Decision 1)

- Import widened to include `resolveWithinRoot`.
- `rawFramesDir(jobId)`: `path.join(TEMP_EXTRACTED_DIR, jobId)` → `resolveWithinRoot(TEMP_EXTRACTED_DIR, jobId)`.
- `applyStagingDir(jobId)`: `path.join(TEMP_EXTRACTED_DIR, jobId, APPLY_SUBDIR)` → `resolveWithinRoot(..., APPLY_SUBDIR)`.
- `aiRunDir(jobId, runId)`: `path.join(SPOKE_AI_DIR, jobId, runId)` → `resolveWithinRoot(SPOKE_AI_DIR, jobId, runId)` (validates BOTH segments).
- `prepareCleanApplyStaging`: removed the leading `assertJobId(jobId)` (validation now happens inside the path helpers it calls).
- **Removed** the now-orphaned local `assertJobId` (was non-empty-only; superseded by the stronger shared guard). `assertNoSegmentDoubling` (equal-adjacent-segment tripwire) and `cleanupApplyStaging` (`_apply`-leaf guard + `safeDelete`) are **unchanged**.

### 3. `server/services/templateMaskFolderManager.ts` (was `tempFolderManager.ts`, 131 lines) — guard + rename (Decisions 1 & 2)

- Header comment rewritten to record the rename and that it manages `spokes/template_mask/` (never `temp_processed/`).
- Import widened to include `resolveWithinRoot`.
- `createJobTempFolder`, `cleanupJobTempFolder`, `getJobTempFolder`: `path.join(this.TEMP_BASE, jobId)` → `resolveWithinRoot(this.TEMP_BASE, jobId)`.
- `saveProcessedImage` routes through `getJobTempFolder`, so the guard covers it transitively; its filename is built with `path.basename` (already safe). Unchanged.

### 4. `server/services/videoProcessor.ts` — import + room-scope + comments (5B-1b, 5B-2a, 5B-2b)

- Line 8 import → `./templateMaskFolderManager`.
- Lines 388 & 698: `temp_processed/{jobId}/` comments → `spokes/template_mask/{jobId}/`.
- `updateProgress` (1077–1090): `this.io.emit('progress', { jobId, ...progress })` → `this.io.to(jobId).emit('progress', { jobId, ...progress })`, with a comment noting clients join via `socket.on('join', jobId => socket.join(jobId))` and that the AI path was already room-scoped.

### 5. `server/handlers/templateMaskApply.ts` — import only (5B-2a)

Line 16 import → `../services/templateMaskFolderManager`. The shared apply function itself is untouched.

### 6. `server/index.ts` — dynamic import (5B-2a)

Line 57 `await import('./services/tempFolderManager')` → `await import('./services/templateMaskFolderManager')`. This is a **string** import, so a typo would fail at boot, not `tsc` — see verification below.

### 7. `server/routes.ts` — debug endpoints removed (5B-1d)

Deleted the `POST /api/test-post` and `POST /test-non-api` handlers (console.log + json stubs; no client callers). 18 lines removed.

### 8. `server/storage.ts` — progress-map cleanup folded in (5B-2c, Decision 3)

- `IStorage`: added `deleteProcessingProgress(jobId): Promise<void>`.
- `MemStorage`: implemented it (`this.processingProgress.delete(jobId)`).
- `deleteVideoJob`: now `await this.deleteProcessingProgress(id)` before `this.videoJobs.delete(id)`, so **every** delete path frees the entry. (`Map.delete` on a missing key is a safe no-op.)

### 9. `server/pgStorage.ts` — interface symmetry (5B-2c)

`PgStorage` also implements `IStorage` and is type-checked even though never loaded at
runtime. Added the matching `deleteProcessingProgress`. **This is required to keep `tsc`
at 17** — without it `tsc` reported 18 (a `TS2420 incorrectly implements interface`).

### 10. `CLAUDE.md` — backlog updated (see below)

---

## tsc verification

```
$ npx tsc --noEmit | grep -c "error TS"
17
  10 server/services/frameExtractor.ts
   7 server/services/maskWorker.ts
```

Exactly the pre-existing baseline. Transient note: adding the `IStorage` method first
produced 18 (the `PgStorage` `TS2420`); adding `PgStorage.deleteProcessingProgress`
restored 17. No new error in any file that was clean before.

---

## Two load-bearing verifications

These are the items that **boot logs alone cannot prove**; flagged here so the live
verifier knows exactly what to test.

### A. Rename — dynamic import must actually fire (Decision 2)

The `index.ts:57` import is a runtime string. A bad path would reject the `await import()`
**before** `TempFolderManager.initialize()` runs. The IIFE (`index.ts:55–109`) has no local
`try/catch` around line 57, and `initialize()`'s own internal `try/catch` only wraps its
`fs.mkdir` — it does **not** swallow a failed import. So a typo'd path would surface as an
unhandled rejection at boot, not a silent no-op.

**Observed at boot** (`PORT=… npx tsx server/index.ts`): all four `🧹` startup-cleanup
log lines printed — and those functions are invoked at `index.ts:69–72`, strictly **after**
`await TempFolderManager.initialize()` at line 58. Their appearance proves the dynamic
import resolved and `initialize()` returned cleanly. (`initialize()` logs nothing on
success — the proof is the downstream cleanup logs, not a line from `initialize` itself.)
The two boot failures seen afterward are pre-existing/environmental and downstream of
boot: `serveStatic` needs a built client (prod path), and `reusePort: true` throws
`ENOTSUP` on this macOS/Node host (`index.ts:101`) — neither is related to this change.

### B. Room-scoped progress — needs a two-tab test

`io.to(jobId).emit(...)` only delivers to sockets that joined that room. Confirm:
1. **Isolation:** open two browser tabs on two different jobs; each tab's progress bar
   advances **only** for its own job (before this change, both saw every job's events).
2. **No regression:** a single in-flight job still shows live progress end-to-end
   (the client already calls `socket.emit('join', jobId)` — verify it fires before the
   first `progress` event, else early ticks are missed).

---

## Rollback

Single deploy, fully reversible: `git revert` the deploy commit. The `git mv` reverts
cleanly (history preserved); re-adding the two debug endpoints and reverting the one-line
broadcast/guard changes are mechanical. No data migration, no schema change, no disk
layout change.
