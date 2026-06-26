# Phase 5B Proposal — Backend Cleanup + Deferred Phase 1 Security Items

**Status:** proposal only — no code edited (per kickoff §0).
**Verified against:** current `main` source on disk, this session.
**`tsc` baseline:** 17 (10 `frameExtractor.ts`, 7 `maskWorker.ts`) — every sub-stage must keep it at 17.

> **Headline reconciliation:** the kickoff's line numbers are stale leads, and one whole
> sub-stage is already done. Corrected facts per item below. Two of the four sub-stages
> shrink to near-zero work against current source:
> - **5B-3 (legacy alias removal) is already complete** — Phase 4d-2 removed every alias
>   in the list; only canonical routes remain. The entire logging-prep → gate → deletion
>   staging is moot. **Recommend: close as done, no deploy.**
> - **5B-4 (`temp_processed/` sweep removal)** has strong *static* evidence it's quiet
>   (no writer exists), but the gate is a *runtime* "quiet for several days" condition I
>   cannot observe from here. **Recommend: defer**, per the kickoff's own instruction.

---

## 5B-1 — Phase 1 security items (additive/low-risk, reversible)

### 1a. Path-traversal guard in `TempFolderManager`

**Confirm/correct.** Guard is **absent** — confirmed. `server/services/tempFolderManager.ts`
builds every path as `path.join(this.TEMP_BASE, jobId)` with no validation:
- `createJobTempFolder` (line 19), `cleanupJobTempFolder` (line 35), `getJobTempFolder`
  (line 63), and `saveProcessedImage` (lines 75/83) all interpolate `jobId` (and
  `originalName`) straight into a path. A crafted `jobId` like `../../uploads` would
  resolve outside `spokes/template_mask/`.
- Note: the **delete** side of the app is already bounded — `cleanup.ts:safeDelete`
  (lines 86–101) re-resolves and refuses anything outside the allowed root. The gap is
  the **create/write** side in `TempFolderManager`, which has no equivalent.

**Change & why minimal.** Add a single private validator in `TempFolderManager` that
normalizes `jobId` and rejects it if it contains a path separator or resolves outside
`TEMP_BASE`; call it at the top of each method that takes `jobId`. Mirror the existing
`safeDelete` resolve-and-compare pattern so the guard reads consistently with the
codebase. No call-site changes, no signature changes.

**Blast radius.** `TempFolderManager` is imported by `videoProcessor.ts` (line 8),
`handlers/templateMaskApply.ts` (line 16), and `index.ts` (line 57, dynamic). All pass a
server-generated `jobId`, so a legitimate caller is never rejected — the guard only fires
on a malicious/garbage id. `originalName` in `saveProcessedImage` is already reduced via
`path.basename`; the guard adds defense-in-depth, not a behavior change for valid input.
(`applyPaths.ts` also does `path.join(TEMP_EXTRACTED_DIR, jobId)` — **out of scope** for
this item, which is scoped to `TempFolderManager`; flagged in "Observed but out of scope".)

**Verification (post-deploy).** Server-side: call the create/save path with a traversal
`jobId` (e.g. via a unit harness or a crafted request) → expect rejection/throw, no folder
created outside `spokes/template_mask/`. Normal `jobId` → folder created as before, full
template-mask flow still works.

### 1b. Global `progress` broadcast → room-scoped

**Confirm/correct.** Kickoff cites `videoProcessor.ts:999`; that line is
`let completedFrames = 0;` — **stale ref.** The actual broadcast is **`videoProcessor.ts:1081`**,
inside `updateProgress`:
```
this.io.emit('progress', { jobId, ...progress });
```
`io.emit` broadcasts to **all** connected clients → every browser sees every job's
progress. Leak confirmed.

**Change & why minimal.** One line: `this.io.emit('progress', …)` → `this.io.to(jobId).emit('progress', …)`.
The room infrastructure **already exists and is already used elsewhere**:
- `routes.ts:1199` — `socket.on('join', (jobId) => socket.join(jobId))`; clients already
  join a room named by `jobId`.
- The AI inference path already emits room-scoped: `io?.to(jobId).emit('inference-progress', …)`
  at `routes.ts:951, 973, 1001, 1027`.
So this change makes the template-mask/video `progress` event consistent with the AI
path — no new infra, no client change required (the client already joins the room).

**Blast radius.** Any client that listens for `progress` *without* joining the room would
stop receiving it. The canonical client joins on mount (the AI path already depends on
this), so the risk is a stray legacy listener. This is the one item where a live check is
worth doing even though it's reversible (see verification).

**Verification (post-deploy).** Run two concurrent jobs in two browser tabs → each tab
sees only its own progress bar advance; neither sees the other's. Confirm the single-job
progress bar still updates normally (regression check that the room join is wired).

### 1c. Dead code at `routes.ts:361`

**Confirm/correct.** **Could not confirm — the cited line is live code.** `routes.ts:361`
is `height: imageMeta.height` inside the image-batch `fileList` builder (lines 351–362),
which feeds `createVideoJob`. It is reached on every multi-image upload. No dead callsite
exists at or adjacent to 361.

**Recommendation.** Do **not** remove anything here. Per the kickoff's "don't fix non-bugs"
and "confirm-before-delete," this item needs Andre to re-cite the actual dead block (line
numbers drift across phases) or drop it. **No change proposed** until the reference is
corrected.

### 1d. Debug endpoints `/api/test-post` and `/test-non-api`

**Confirm/correct.** Both **exist and are non-load-bearing** — confirmed.
- `routes.ts:114` `app.post("/api/test-post", …)` — logs the body, returns `{success:true}`.
- `routes.ts:123` `app.post("/test-non-api", …)` — same shape, used historically to prove a
  route bypasses Vite.
- Client grep for `test-post` / `test-non-api`: **no matches.** The frontend never calls them.

**Change & why minimal.** Delete the two route blocks (lines 113–129, including their
comments). Nothing else references them.

**Blast radius.** None in-app (no client callsite). External callers (curl smoke tests)
would 404 — that is the intended outcome.

**Verification (post-deploy).** `POST /api/test-post` and `POST /test-non-api` → 404.
App upload/mask/apply/AI/download/delete flow unaffected. (This is a removal — treat with
confirm-before-delete care, but static evidence here is strong and the live 404 check
closes it.)

---

## 5B-2 — Renames and comment fixes (reversible, no behavior change)

### 2a. Rename `tempFolderManager.ts`

**Confirm/correct.** The file's own header already admits the misnomer ("Despite the
legacy name, this no longer touches `temp_processed/`" — it manages
`SPOKE_TEMPLATE_MASK_DIR`, i.e. `spokes/template_mask/`). Full importer list confirmed:
- `server/services/videoProcessor.ts:8` — `import { TempFolderManager } from './tempFolderManager';`
- `server/handlers/templateMaskApply.ts:16` — `import { TempFolderManager } from '../services/tempFolderManager';`
- `server/index.ts:57` — **dynamic** `await import('./services/tempFolderManager')`.

That's **3 import sites** (2 static, 1 dynamic-string). All the `TempFolderManager.*`
call-sites (videoProcessor lines 390/391/392/417/447/523/524/611/675/701/717/746,
templateMaskApply line 63) reference the **class name**, which does **not** change on a
file rename.

**Proposed name.** **`templateMaskFolderManager.ts`** — it precisely names the spoke it
manages (`spokes/template_mask/`). (`spokeFolderManager.ts` is the alternative but is less
precise — it manages one spoke, not all of them.) **Rename the file only; keep the class
name `TempFolderManager`** to hold the diff to import paths + filename and avoid touching
~15 call-sites. If you'd prefer the class renamed too, say so and I'll widen the scope.
→ **Andre confirms the filename before I touch anything.**

**Change & why minimal.** `git mv` the file, update the 3 import specifiers (including the
dynamic-import string in `index.ts:57`). No logic change.

**Blast radius.** Build-time only. The dynamic import in `index.ts` is the one that won't
surface as a `tsc` error if mistyped (it's a string) — must be eyeballed and exercised on
boot. `tsc` must stay 17 after.

**Verification (post-deploy).** Build green; `tsc` = 17; server boots (exercises the
`index.ts` dynamic import → `TempFolderManager.initialize()`); full template-mask flow
works end-to-end (exercises the other two importers).

### 2b. Stale `videoProcessor.ts` comments

**Confirm/correct.** Kickoff cites lines 371 and 643; actual stale comments are at
**`videoProcessor.ts:388`** ("Persist processed frames to `temp_processed/{jobId}/`…") and
**`videoProcessor.ts:698`** ("Frames are already saved to `temp_processed/{jobId}/`…").
Both are wrong: the code immediately below each uses `TempFolderManager.getJobTempFolder(jobId)`,
which resolves to `spokes/template_mask/<jobId>/`, **not** `temp_processed/`.

**Change & why minimal.** Comment-only edit at 388 and 698: replace `temp_processed/{jobId}/`
with `spokes/template_mask/{jobId}/`. Zero behavior change. (These two stale comments are
also the source of the `temp_processed`-is-still-written misconception relevant to 5B-4.)

**Blast radius.** None (comments).

**Verification.** N/A runtime; visual diff review only.

### 2c. `deleteProcessingProgress(jobId)` on job delete

**Confirm/correct.** Leak **confirmed.** `server/storage.ts` holds
`private processingProgress: Map<…>` (line 81) with `getProcessingProgress` (167) and
`updateProcessingProgress` (171, does `.set`) — but **no delete**. `deleteVideoJob`
(lines 262–264) only does `this.videoJobs.delete(id)`; it never touches
`processingProgress`. The DELETE handler `routes.ts:1823` calls `cleanupJobArtifacts`,
`deleteUploadFile`, `deleteVideoJob`, `deleteJobV2` — none clears the progress map. So a
delete leaves a stale `processingProgress` entry forever (process-lifetime leak in
MemStorage).

**Change & why minimal.** Add `deleteProcessingProgress(jobId)` to the `IStorage`
interface + `MemStorage` (one `this.processingProgress.delete(jobId)`), and call it from
the DELETE path. Cleanest placement: inside `deleteVideoJob` (so every delete route gets
it for free) — but since `IStorage` is the shared contract, I'll wire the explicit call in
the `routes.ts:1823` handler next to the other `delete*` calls to keep it visible and
symmetric. **Andre: preference between "fold into `deleteVideoJob`" vs "explicit call in
the handler"?** Default = explicit call in handler.

**Blast radius.** Additive — new method, one new call. No existing behavior changes. `tsc`
stays 17 (new interface member is implemented).

**Verification (post-deploy).** Create a job, let it report progress, `DELETE /api/jobs/:jobId`,
then `GET` its progress → expect "not found"/undefined (entry gone). App otherwise
unaffected.

---

## 5B-3 — Legacy URL alias removal (ONE-WAY — gated) → **ALREADY DONE**

**Confirm/correct.** **Every alias in the kickoff list is already gone** — removed in
Phase 4d-2. Evidence in current `routes.ts`:
- `:1108` — "legacy GET `/api/ai/labels/:jobId` removed in Phase 4d-2"
- `:1463` — "legacy alias GET `/api/jobs/:jobId/masks/:labelId/:n.png` removed in Phase 4d-2"
- `:1513` — "legacy alias GET `/api/jobs/:jobId/overlays/:labelId/:n.png` removed in Phase 4d-2"
- `:1635` — legacy PATCH `/internal/mask-processing/:jobId` removed; the shared function in
  `server/handlers/templateMaskApply.ts` **stays** (constraint honored — it's still imported
  and used).
- Grep for `videos/upload`, `images/upload`, `videos/:jobId` (GET/download), `ai/infer`:
  the only surviving `/api/videos/...` route is **`POST /api/videos/:jobId/process`**
  (`:454`), which is **not** in the alias list (it's a live canonical-style action route).
- Client grep for any legacy alias path: **no matches.** Frontend is fully on canonical
  URLs (consistent with Phase 4's live-verified migration).

**Reversible prep vs irreversible deletion.** **N/A** — there is nothing left to log,
gate, or delete. The staged logging-prep deploy, the live-log sweep gate, and the deletion
deploy are all **moot**.

**Recommendation.** Close 5B-3 as **already complete**. No deploy. The only residual action
worth doing is documentation: ensure `CLAUDE.md`'s backlog reflects that 4d-2 already did
this (see Deliverables). If Andre wants belt-and-suspenders confidence, the existing Phase
4d pattern grep still passes:
```
grep -rn "registerRoute\|app.post\|app.get\|app.patch\|app.delete" server/routes.ts
```
→ shows only canonical `/api/jobs/:jobId/...` (plus the `/api/videos/:jobId/process`
action route, which is not an alias). **No one-way change is being proposed in 5B-3.**

---

## 5B-4 — `temp_processed/` sweep-target removal (ONE-WAY — gated) → **DEFER**

**Confirm/correct (static).** No code writes to `temp_processed/` anymore:
- Every "temp_processed" occurrence in `server/` is either (a) a **stale comment**
  (`videoProcessor.ts:388, 698` — fixed in 5B-2) or (b) **defensive cleanup infra** in
  `cleanup.ts`: the `TEMP_PROCESSED_DIR` constant (`:45`), its inclusion in `SWEEP_TARGETS`
  (`:68`, already annotated "remove once confirmed no writes occur"), `cleanupJobArtifacts`
  (`:137`), and `purgeTempProcessedOnStartup` (`:286`).
- The template-mask and image-batch output paths that the stale comments *describe* both
  actually call `TempFolderManager.getJobTempFolder` → `spokes/template_mask/`. There is no
  `fs.writeFile`/`mkdir` against `TEMP_PROCESSED_DIR` anywhere in the tree.

So the static picture says `temp_processed/` is genuinely dead since the Phase 3a flag day.

**Why still defer — the gate is runtime, not static.** The kickoff's gate is explicit:
remove "once confirmed quiet for several days … empty across recent boots." That is an
**observational** condition about the deployed server (`3.136.48.97`) — boot logs from
`purgeTempProcessedOnStartup` reporting "0 entries" across several days, and no hourly-sweep
deletions in `temp_processed/`. **I have no access to those logs or the running host**, so
I cannot satisfy the gate. Per the kickoff's own directive ("If you can't confirm the
'quiet for several days' condition from available evidence, leave this for a later phase
and note it — don't remove a defensive sweep on a hunch"), this stays parked.

**Reversible prep vs irreversible deletion.**
- *Reversible prep (none needed now):* the static audit above **is** the prep. No code
  change.
- *Irreversible deletion (deferred):* remove `TEMP_PROCESSED_DIR` from `SWEEP_TARGETS`
  (`cleanup.ts:68`) and remove `purgeTempProcessedOnStartup` (+ its boot call in
  `index.ts`). Optionally drop the `TEMP_PROCESSED_DIR` constant and its
  `cleanupJobArtifacts` entry. **Gate that must pass first:** Andre confirms, from the live
  host, that `purgeTempProcessedOnStartup` has logged zero entries across several recent
  boots and the hourly sweep hasn't deleted anything from `temp_processed/`.

**Recommendation.** **Defer to a later mini-phase.** Carry the static finding forward so the
eventual removal is a 10-minute change once the runtime "quiet" evidence is in hand.

---

## Proposed sequencing (what actually ships)

Given the reconciliations, 5B collapses to **one reversible deploy** plus deferrals:

1. **Deploy 1 (all reversible, low-risk):** 5B-1a (traversal guard), 5B-1b (room-scope
   progress), 5B-1d (remove debug endpoints), 5B-2a (file rename), 5B-2b (comment fixes),
   5B-2c (progress-map cleanup). All additive or behavior-preserving; `tsc` stays 17.
2. **5B-1c (dead code):** blocked — needs a corrected line reference from Andre.
3. **5B-3:** already done — documentation-only (tick the backlog).
4. **5B-4:** deferred — pending runtime "quiet" confirmation on the live host.

No one-way deletion is proposed in this phase (5B-3 already executed in 4d-2; 5B-4 gated
out). That removes the multi-deploy logging/gate dance the kickoff anticipated for 5B-3.
**If Andre disagrees and wants 5B-1d treated as a gated one-way item too, I'll split it
out** — but its static evidence (zero client callsites) plus the trivial live 404 check
seem sufficient.

---

## Observed but out of scope

- **`applyPaths.ts` path interpolation.** `getRawFrameDir`/`getApplyStagingDir` (lines
  60/72) and the run dir (`:144`) `path.join(TEMP_EXTRACTED_DIR, jobId[, …])` with no
  traversal guard, same shape as the `TempFolderManager` gap. The 5B-1a guard is scoped to
  `TempFolderManager` per the kickoff; if you want the guard applied uniformly at every
  `jobId`-as-path boundary, that's a (small) scope expansion to call out — not assumed here.
- **`cors: { origin: "*" }`** on the Socket.IO server (`routes.ts:100–102`). Wide-open CORS;
  not in the 5B backlog. Noted, untouched.
- **Phase 6 manifest builders** (`routes.ts` ~621–747 and ~1742–1780) — explicitly parked;
  not read/modified.
- **`MemStorage`/Postgres durability** (5C) and the `PgStorage` keep/remove decision —
  `storage.ts:271–275` shows `PgStorage` import is *intentionally omitted* and `./db` never
  loaded. It is effectively dormant but the file may still exist; this is a 5C call, left
  untouched.
- **The 17 pre-existing `tsc` errors** in `frameExtractor.ts`/`maskWorker.ts` — separate
  backlog item, untouched.

---

## Deliverables tracking (per kickoff §5)

- This proposal → review/amend/green-light loop (same as 5A).
- On green-light: implement **Deploy 1** (the six reversible items), then `PHASE_5B_REPORT.md`
  with files touched, line counts, confirmed root state, `tsc`=17, and the server-side/browser
  verification steps for the live host.
- `CLAUDE.md` backlog update (diff shown before commit): tick 5B-1 (a/b/d), 5B-2 (a/b/c),
  mark **5B-3 done (via 4d-2)**; leave **5B-1c** open pending a corrected ref; leave
  **5B-4** parked with the static finding + runtime gate noted; leave Phase 6 / 5C parked.
