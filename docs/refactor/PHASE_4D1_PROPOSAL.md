# Phase 4d-1 — Migrate remaining legacy frontend callsites + exhaustive audit

**Status:** APPROVED with amendments (`PHASE_4D1_AMENDMENT.md`). Implementing.
**Phase:** 4d-1 (REVERSIBLE prep). Removes NOTHING — that is 4d-2.
**Scope:** Frontend migrations + **one surgical backend payload addition** (add
`runId` to `inference.json`'s per-frame labels, per amendment Change 1) + a
complete static audit.

---

## 0. Premise & constraints (acknowledged)

- 4d-1 is the **reversible** half of the teardown. **REMOVE NOTHING**: no alias
  removal, no route removal, no `home.tsx` deletion, no `/app` removal. All of
  that is 4d-2, kicked off separately only after 4d-1 deploys and its audit is
  clean.
- **Backend is read-only EXCEPT one surgical payload addition** (amendment
  Change 1): add a `runId` field to `inference.json`'s per-frame labels so
  FrameViewer can build the canonical runId-scoped overlay URL directly — no
  frontend fallback to the legacy alias. The "backend read-only" rule was a
  conservative default; relaxing it for this localized field addition *reduces*
  risk on the one-way 4d-2 removal (it removes a silent legacy dependency). No
  other handler, no route registration, changes. If adding `runId` required more
  than a localized field addition I would STOP and flag — it does not (the run↔
  label map is already built at the construction site; see §2.3).
- Do NOT touch the b734e6d re-entrancy fix, `applyPaths.ts`, the tripwire, or
  retention.
- `npx tsc --noEmit` stays **exactly 17** (10 `frameExtractor.ts` +
  7 `maskWorker.ts`). These migrations add no new type errors.
- The audit is the **load-bearing deliverable**: 4d-2 may only remove an alias
  that the audit proves the frontend never hits. Every claim of "unused" must be
  backed by a grep with `file:line`.

---

## 1. Preliminary reconnaissance (evidence gathered for this proposal)

This is the recon that informs the plan below. The **exhaustive** per-URL table
lands in `PHASE_4D1_REPORT.md` after implementation; the findings here are the
grep evidence that scopes the migrations.

### 1.1 Legacy callsites found in `client/`

| # | File:line | Legacy URL | Reachable from canonical app? | Disposition |
|---|---|---|---|---|
| 1 | `CommandInput.tsx:480` | `POST /api/ai/infer` | **YES** (ai-spoke renders CommandInput) + home.tsx | **MIGRATE** (straggler) |
| 2 | `ProcessingStatus.tsx:88` | `GET /api/videos/:jobId/download` | **YES** (template-mask-spoke renders ProcessingStatus) + home.tsx | **MIGRATE** (straggler) |
| 3 | `FrameViewer.tsx:225` | `GET /api/jobs/:jobId/overlays/:labelId/:n.png` (labelId-only alias) | **YES** (ai-spoke renders FrameViewer) + home.tsx | **MIGRATE via backend runId-in-payload** (straggler — NOT in the kickoff's known list; see §2.3) |
| 4 | `home.tsx:118` | `GET /api/ai/labels/:jobId` | home.tsx only | leave (dies with file in 4d-2) |
| 5 | `home.tsx:136` | `PATCH /api/ai/labels/:jobId/:labelId` | home.tsx only | leave (4d-2) |
| 6 | `home.tsx:150` | `DELETE /api/ai/labels/:jobId/:labelId` | home.tsx only | leave (4d-2) |
| 7 | `home.tsx:175` | `GET /api/videos/:jobId/download` | home.tsx only | leave (4d-2) |
| 8 | `FileUpload.tsx:35` | `POST /api/videos/upload` \| `POST /api/images/upload` | **home.tsx only** (FileUpload imported only by `home.tsx:3`) | leave (4d-2) |

**Component reachability (why #1–#3 are live, #8 is not):**
- `CommandInput` → imported by `ai-spoke.tsx` (canonical) **and** `home.tsx`.
- `ProcessingStatus` → imported by `template-mask-spoke.tsx` (canonical) **and** `home.tsx`.
- `FrameViewer` → imported by `ai-spoke.tsx` (canonical) **and** `home.tsx`.
- `FileUpload` → imported **only** by `home.tsx`. The canonical `upload.tsx`
  does its own inline upload, so `FileUpload` dies with `home.tsx` in 4d-2 and
  needs no migration.

### 1.2 Already-canonical (verified — no action)

- **Upload (the high-traffic 404 risk):** `upload.tsx:117` uses
  `/api/uploads/video` + `/api/uploads/images`. ✅ The canonical app does **not**
  hit legacy `/api/videos/upload` or `/api/images/upload` (only the dying
  `FileUpload`/home.tsx does).
- **AI spoke (4b-ii):** labels via `GET /api/jobs/:jobId/ai/runs`, runId-scoped
  approve/delete, `useJob()` `ready` gate. ✅
- **Template-mask spoke (4b-i):** apply via
  `POST /api/jobs/:jobId/template-mask/apply` (`ProcessingControls.tsx:85`),
  frame preview via `GET /api/jobs/:jobId/frames/0`
  (`template-mask-spoke.tsx:47`). ✅
- **Job state:** `JobContext.tsx:22` uses `GET /api/jobs/:jobId` (canonical V2).
  No bare legacy `GET /api/videos/:jobId` poll remains in the canonical app (the
  ai-spoke poll was removed in 4b-ii).

### 1.3 Legacy aliases with NO frontend consumer (preliminary — confirm in report)

- `GET /api/jobs/:jobId/masks/:labelId/:n.png` (labelId-only mask alias):
  **no client callsite** — FrameViewer fetches *overlays* (#3), never *masks*.
  Likely safe to remove in 4d-2 with zero migration. The report's exhaustive
  grep will confirm.
- `PATCH /internal/mask-processing/:jobId`: no client callsite (the spoke uses
  the canonical apply alias). Confirm in report.

---

## 2. Straggler migrations (the only code changes in 4d-1)

### 2.1 `CommandInput.tsx` — infer trigger

- **Change:** `POST /api/ai/infer` → `POST /api/jobs/${jobId}/ai/runs` (line 480).
- **Request shape verified identical.** The handler is the *same function*
  (`aiInferHandler`) registered at both `POST /api/ai/infer` (`routes.ts:1104`)
  and `POST /api/jobs/:jobId/ai/runs` (`routes.ts:1105`). It resolves
  `const jobId = req.params.jobId ?? req.body.jobId` (`routes.ts:881`) and reads
  `{ command, frameBase64, bbox, useAutoPrompt, modality }` from the body
  (`routes.ts:882`). CommandInput currently sends
  `{ jobId, command, frameBase64, bbox, useAutoPrompt, modality }`
  (`CommandInput.tsx:483–490`). After migration, `jobId` comes from the path;
  the body `jobId` is redundant but harmless. The response is identical
  (same handler) → `onMaskGenerated`/overlay/confidence flow unchanged.
- **Shared-component note (per kickoff):** CommandInput is rendered by both the
  AI spoke and legacy `home.tsx`. Migrating changes the URL for **both**. That is
  acceptable: home.tsx is deleted in 4d-2, and the canonical URL works regardless
  of caller. I will leave the redundant body `jobId` in place (removing it is
  pointless churn and keeps the diff to one line).

### 2.2 `ProcessingStatus.tsx` — template-mask download

- **Change:** `GET /api/videos/${jobId}/download` →
  `GET /api/jobs/${jobId}/template-mask/download` (line 88).
- Same handler (alias pair per the URL hierarchy table). ProcessingStatus is
  used by the canonical `template-mask-spoke.tsx`, so this is a live straggler.
- `home.tsx:175`'s own copy of the download URL (with the output-settings query
  string) is **left as-is** — home.tsx dies in 4d-2. Flagging the choice
  explicitly per the kickoff: I am NOT migrating home.tsx's copy.

### 2.3 `FrameViewer.tsx` overlay URL — BACKEND runId-in-payload (amendment Change 1)

This is the one NOT in the kickoff's "known stragglers" list. Per the amendment,
it uses the **backend runId-in-payload fix, NOT a frontend fallback.**

- **Problem:** the canonical overlay URL is **runId-scoped**:
  `GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png`
  (`routes.ts:1595`). FrameViewer currently builds the **labelId-only** legacy
  alias `GET /api/jobs/:jobId/overlays/:labelId/:n.png` (`FrameViewer.tsx:225`).
  FrameViewer builds overlay URLs **only** from `PerFrameLabel` objects — the
  render at `FrameViewer.tsx:390` (`overlayUrl(l.labelId, currentFrame)`, `l` a
  `PerFrameLabel`) and the prefetch at `FrameViewer.tsx:278`. `PerFrameLabel`
  carries `labelId` but **not `runId`** (`FrameViewer.tsx:32–40`).

- **Fix (backend, surgical):** add `runId` to the per-frame label objects the
  `inference.json` handler emits. The run↔label map is **already built at the
  construction site**: `inference.json` builds `labelDirMap` by iterating the
  runs (`routes.ts:1448–1451`: `for (const r of inferRuns) for (const rl of
  r.labels) labelDirMap.set(rl.id, r.outputDir)`). I add a parallel
  `labelRunIdMap.set(rl.id, r.id)` in that same loop and set
  `runId: labelRunIdMap.get(l.id) ?? null` on the pushed per-frame object
  (`routes.ts:1467–1475`). `runId` is sourced from the run that owns the label
  (`AIRun.id`) — exactly the source the 4b-ii AI-spoke migration used. **This is
  the entire backend change: one map + one field, one handler.** `viewer-info`
  needs **no** change — it never feeds overlay URLs.

  Whenever an overlay is actually rendered the label is gated by `hasMask`
  (`FrameViewer.tsx:386`), and `hasMask` is itself true only when
  `labelDirMap.get(l.id)` resolved a run dir (`routes.ts:1465–1466`). So `runId`
  is guaranteed present exactly when it is used; the `?? null` is dead-defensive
  for the never-rendered case.

- **Frontend (FrameViewer):**
  - Add `runId: string | null` to the `PerFrameLabel` interface.
  - `overlayUrl(runId, labelId, n)` →
    `` `/api/jobs/${jobId}/ai/runs/${runId}/overlays/${labelId}/${n}.png` ``.
  - Render callsite: `overlayUrl(l.runId, l.labelId, currentFrame)`, with the
    existing `.filter(l => l.hasMask)` tightened to `.filter(l => l.hasMask &&
    l.runId)` so the runId is present.
  - Prefetch callsite: `find` the matching per-frame label and use its `runId`.
  - **NO third fetch, NO `labelId→runId` map, NO fallback to the legacy
    labelId-only URL.** After this, FrameViewer has **zero** constructors of the
    legacy overlay alias (proven by grep in the report — amendment Change 2).
- tsc impact: none new (the runs shape is already typed; `PerFrameLabel` is a
  local interface).

---

## 3. THE exhaustive audit (report deliverable — method defined here)

For **every** legacy URL slated for 4d-2 removal, the report will grep all of
`client/` for the literal string and templated forms, record **every** hit with
`file:line`, and classify each:

- **(a) migrated in 4d-1** — now hits the canonical URL.
- **(b) home.tsx-only** — dies with the file in 4d-2; no migration needed.
- **(c) still-live elsewhere** — **BLOCKER**: must be migrated before 4d-2 can
  remove the alias.

**URLs to audit (each gets a row):**
```
POST   /api/videos/upload
POST   /api/images/upload
GET    /api/videos/:jobId
GET    /api/videos/:jobId/download
PATCH  /internal/mask-processing/:jobId
POST   /api/ai/infer
PATCH  /api/ai/labels/:jobId/:labelId
DELETE /api/ai/labels/:jobId/:labelId
GET    /api/jobs/:jobId/masks/:labelId/:n.png       (labelId-only)
GET    /api/jobs/:jobId/overlays/:labelId/:n.png    (labelId-only)
```

**Grep technique:** search for stable substrings, not full templated strings
(e.g. `/api/ai/infer`, `/api/videos/`, `/download`, `mask-processing`,
`/api/ai/labels/`, `overlays/`, `masks/`, `/api/videos/upload`,
`/api/images/upload`), then read each hit to classify. Distinguish the
labelId-only alias from the runId-scoped canonical form by the path segment
before the labelId.

**Output:** a table `legacy URL → grep hits (file:line) → classification →
"safe to remove in 4d-2?" (yes/no)`. **This table is the gate for 4d-2.** Any
row that is "still-live elsewhere" is called out as a BLOCKER.

**Amendment Change 2 — prove the negative, don't assert it.** Every row marked
"safe to remove in 4d-2 = **yes**" must show the grep (file:line) proving that
**zero** code paths in `client/` still construct that legacy URL — including any
fallback/default/error path. In particular, the row for
`GET /api/jobs/:jobId/overlays/:labelId/:n.png` (labelId-only) must confirm the
only remaining overlay constructor anywhere in `client/` is the canonical
runId-scoped form (`/ai/runs/:runId/overlays/...`). A "yes" with no grep is not
acceptable; the table prints the command output that establishes the negative.

**Expected result given §1 recon** (to be confirmed exhaustively in the report):
upload URLs, `/api/videos/:jobId/download`, infer, and overlays will be
"safe = yes" once #1–#3 are migrated and the home.tsx-only hits are recognized;
`/api/ai/labels/*` and the legacy `videos/download` are home.tsx-only (safe);
`masks` labelId-only and `/internal/mask-processing` have no frontend consumer
(safe). The bare `GET /api/videos/:jobId` is expected to have zero canonical-app
hits (poll removed in 4b-ii).

---

## 4. CLAUDE.md update (required; applied during implementation)

- Record **4d-1 landed**: stragglers migrated (CommandInput infer,
  ProcessingStatus download, FrameViewer overlay-with-runId), audit table
  produced.
- Record the **audit result**: which legacy URLs are confirmed unused
  (safe for 4d-2) vs still-live, and that `upload.tsx` is confirmed canonical.
- **FLAG (do NOT fix) two post-4d AI-spoke canvas-polish bugs**, tagged
  "post-4d, AI-spoke canvas polish," with diagnosis only:
  1. The shared `MaskingCanvas` exposes template-mask **rectangle drawing**
     inside the AI spoke; it should be **bbox-only** there. Likely needs a
     mode/context prop to scope drawing behavior per spoke.
  2. The AI bbox **renders small and offset to the side** — likely a
     coordinate-space/scaling mismatch between the displayed canvas and the
     native frame dimensions.
  Diagnosis recorded; no fix in 4d (these belong to the post-refactor canvas
  polish backlog).

---

## 5. Verification plan (post-implementation)

1. **`npx tsc --noEmit` → exactly 17 errors** (unchanged baseline).
2. **Network audit (DevTools), every workflow on the canonical app:**
   - Upload → `POST /api/uploads/video|images` (no legacy upload).
   - Mask apply → `POST /api/jobs/:jobId/template-mask/apply`; download →
     `GET /api/jobs/:jobId/template-mask/download` (no `/api/videos/:jobId/download`).
   - AI infer → `POST /api/jobs/:jobId/ai/runs` (no `/api/ai/infer`).
   - Frame viewer overlays → `GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png`
     (no labelId-only overlay).
   - **No request to any legacy removal-list URL** from the canonical app
     (legacy hits only from `/app`/home.tsx, which 4d-2 deletes).
3. **Functional:** AI infer still produces masks/overlays; the frame viewer
   still renders overlays for approved labels; template-mask download still
   yields the ZIP.
4. **No regression:** the `applyPaths` tripwire stays green
   (`npx tsx server/services/__tests__/applyPaths.test.ts`); the redo loop is
   still clean.
5. **The audit table is complete** — every legacy URL has grep evidence and a
   yes/no removal verdict.

---

## 6. Deliverables

1. **This proposal** — migration plan + audit method (updated per amendment).
2. Implementation: the two frontend straggler migrations (§2.1, §2.2), the
   FrameViewer overlay migration backed by the surgical `inference.json` `runId`
   addition (§2.3), the CLAUDE.md update (§4), verification (§5), and
   `docs/refactor/PHASE_4D1_REPORT.md` **with the full audit table** (§3) plus
   the exact backend payload change documented (which handler/line, how `runId`
   is sourced).

**Nothing is removed in 4d-1. 4d-2 (the one-way teardown) is a separate kickoff
that starts only after this is deployed and the audit is clean.**
