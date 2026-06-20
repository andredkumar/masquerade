# Phase 4d-2 Proposal — the one-way legacy teardown (the final step of Phase 4)

**Status: PROPOSAL. No code written. Awaiting approval.**
**Gate cleared:** 4d-1 + 4d-1b migrated every canonical-app callsite; the live 500-line log sweep
on a fresh job showed ZERO hits to any legacy removal-list URL from the canonical app. This is the
one-way door — after it, Phase 4 frontend migration is COMPLETE.

Follows `PHASE_4D2_KICKOFF.md`. Per the kickoff: **proposal first, wait for approval, then implement.**
This document lists every exact `file:line` removal and, for each removed URL, confirms its **canonical
equivalent + shared handler stays** (with the canonical line cited). tsc baseline is **17**; after
removal it must be **17 or lower, never higher**.

---

## 0. Scope summary

| Area | Action |
|---|---|
| 1.1 Backend route aliases (`server/routes.ts`) | Remove **11** legacy `app.<method>` alias registrations. Canonical sibling + handler stay. |
| 1.2 Backend wrapper (`server/index.ts`) | Remove the `/internal/mask-processing/:jobId` thin wrapper + its now-dead import. `handlers/templateMaskApply.ts` stays. |
| 1.3 Frontend surface | Delete `pages/home.tsx` + `components/FileUpload.tsx`; remove `/app` route + `Home` import (`App.tsx`); redirect the dead `/app` nav link (`landing.tsx`). |
| 1.4 Out of scope | Canonical URLs, shared handlers, `/api/videos/:jobId/process`, b734e6d re-entrancy fix, applyPaths, tripwire, retention, videoProcessor/frameExtractor/tempFolderManager/frameAccess, AI-spoke canvas-polish bugs, broader backlog. |

---

## 1.1 Backend — remove legacy URL alias registrations (`server/routes.ts`)

For each: remove **only the legacy line**. The canonical registration on the adjacent line keeps the
**same named handler** alive, so no handler function is deleted and nothing dangles.

| # | Remove (legacy) | Line | Canonical KEPT | Line | Shared handler (stays) |
|---|---|---|---|---|---|
| 1 | `app.post("/api/videos/upload", upload.single('video'), videoUploadHandler)` | **324** | `app.post("/api/uploads/video", …, videoUploadHandler)` | 325 | `videoUploadHandler` |
| 2 | `app.post("/api/images/upload", imageUpload.array('images'), imageUploadHandler)` | **434** | `app.post("/api/uploads/images", …, imageUploadHandler)` | 435 | `imageUploadHandler` |
| 3 | `app.get("/api/videos/:jobId", getLegacyJobHandler)` | **460** | `app.get("/api/jobs/:jobId", getJobV2Handler)` | 478 | see note A |
| 4 | `app.get("/api/videos/:jobId/download", templateMaskDownloadHandler)` | **854** | `app.get("/api/jobs/:jobId/template-mask/download", templateMaskDownloadHandler)` | 855 | `templateMaskDownloadHandler` |
| 5 | `app.post("/api/ai/infer", aiInferHandler)` | **1104** | `app.post("/api/jobs/:jobId/ai/runs", aiInferHandler)` | 1105 | `aiInferHandler` |
| 6 | `app.get("/api/ai/labels/:jobId", async (req,res)=>{…})` (inline block **1139–1150**) | **1139** | `app.get("/api/jobs/:jobId/ai/runs", async (req,res)=>{…})` | 1704 | see note B |
| 7 | `app.patch("/api/ai/labels/:jobId/:labelId", patchLabelHandler)` | **1193** | `app.patch("/api/jobs/:jobId/ai/runs/:runId/labels/:labelId", patchLabelHandler)` | 1194 | `patchLabelHandler` |
| 8 | `app.delete("/api/ai/labels/:jobId/:labelId", deleteLabelHandler)` | **1235** | `app.delete("/api/jobs/:jobId/ai/runs/:runId/labels/:labelId", deleteLabelHandler)` | 1236 | `deleteLabelHandler` |
| 9 | `app.get("/api/jobs/:jobId/masks/:labelId/:n.png", getMaskHandler)` | **1552** | `app.get("/api/jobs/:jobId/ai/runs/:runId/masks/:labelId/:n.png", getMaskHandler)` | 1553 | `getMaskHandler` |
| 10 | `app.get("/api/jobs/:jobId/overlays/:labelId/:n.png", getOverlayHandler)` | **1603** | `app.get("/api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png", getOverlayHandler)` | 1604 | `getOverlayHandler` |

That is **10 rows / 11 removed lines** (row 6 removes a 12-line inline block, 1139–1150). Rows 1–5,
7–10 are single-line removals.

### Note A — row 3 (`GET /api/videos/:jobId`) — RESOLVED: delete definition too
`getLegacyJobHandler` (the `{ job, progress }` wrapper shape) is referenced **only** by its definition
(line 439–459) and registration (line 460). grep confirmed zero other code references (only docs mention
it). The canonical `getJobV2Handler` (line 463–477, registered at 478) is a **separate** handler
returning the V2 `Job` record and is untouched. **Approved decision:** delete **both** the registration
(460) **and** the now-dead definition block (439–459). A teardown phase removes the legacy surface rather
than leaving dead handlers behind. The kickoff's "do not delete handler functions" rule protects *shared*
handlers; this one is legacy-exclusive.

### Note B — row 6 (`GET /api/ai/labels/:jobId`)
Unlike the others, this legacy route has an **inline, legacy-exclusive handler** (1139–1150) — it is not
a named handler shared with a canonical sibling. Removing the registration therefore necessarily removes
its inline body (1139–1150). The canonical equivalent is the **run-scoped** `GET /api/jobs/:jobId/ai/runs`
(1704, different response shape — runs, not a flat label list), already the canonical-app source since
4d-1. No shared handler is lost.

### Handler-liveness proof
Every *named* handler in the table (`videoUploadHandler`, `imageUploadHandler`,
`templateMaskDownloadHandler`, `aiInferHandler`, `patchLabelHandler`, `deleteLabelHandler`,
`getMaskHandler`, `getOverlayHandler`) appears on **both** its legacy line and its canonical line.
Removing the legacy line leaves ≥1 canonical reference → handler stays live, zero dangling.

### Explicitly LEFT (noticed during recon, NOT on the removal list)
- `server/routes.ts:481` `app.post("/api/videos/:jobId/process", …)` — **left as-is in 4d-2; flagged for
  cleanup backlog.** Examined per request: it is **dead legacy with zero callers.** The canonical
  processing path used by both spokes AND legacy home is `POST /api/jobs/:jobId/template-mask/apply`
  (`ProcessingControls.tsx:85` → `routes.ts:1682`); no client constructs `/api/videos/:jobId/process`
  (broad `client/src` grep = 0). Because it matches `/api/videos/`, the empty live legacy sweep confirms
  no caller hit it during the workflow. It is NOT on the kickoff's removal list, so it stays this phase,
  but it is recorded in `CLAUDE.md` as a cleanup-backlog removal candidate — no unexamined legacy survivor.
- `server/routes.ts:1679` — a *comment* referencing `/internal/mask-processing/:jobId`. Cosmetic; I will
  update it to avoid referencing a now-removed route (comment-only, no behavior).

---

## 1.2 Backend — remove the `/internal/mask-processing` thin wrapper (`server/index.ts`)

- Remove the wrapper block **lines 26–46** (comment 26–28 + `app.patch("/internal/mask-processing/:jobId", …)` 29–46).
- Remove the now-dead import **line 5** `import { applyTemplateMask } from "./handlers/templateMaskApply";`
  — verified used **only** by this wrapper (index.ts grep: refs at lines 5/27-comment/32; line 32 is
  inside the block being removed).
- **STAYS:** `server/handlers/templateMaskApply.ts` (the shared apply function) — the canonical apply
  route `POST /api/jobs/:jobId/template-mask/apply` in routes.ts still imports/uses it. Only the legacy
  thin wrapper goes.

---

## 1.3 Frontend — delete the legacy page surface

### Files deleted
| File | Reason | Import-graph verification |
|---|---|---|
| `client/src/pages/home.tsx` | The legacy single-page app (Path-A monolith). | Referenced only by `App.tsx:7` (import) + `App.tsx:54` (`/app` route), both removed below. |
| `client/src/components/FileUpload.tsx` | Home-only upload component. | grep: imported **only** at `home.tsx:3`, used at `home.tsx:234`. Zero other importers → safe. |

### Import-graph: what `home.tsx` imports and why it is NOT deleted
`home.tsx` imports (lines 1–15): `FileUpload`, `MaskingCanvas`, `MaskingTools`, `ProcessingControls`,
`ProcessingStatus`, `CommandInput`, `TaskSelector`, `FrameViewer`, `colorForLabelId`. Of these, **only
`FileUpload` is home-exclusive.** Every other import is **shared with a canonical spoke** (e.g.
`ProcessingStatus` → `template-mask-spoke.tsx:257`; the masking/AI components → the canonical spokes) and
**MUST NOT be deleted.** Deletion list is therefore exactly the two files above.

> `ProcessingStatus` note: after `home.tsx` is deleted, its only remaining render site is
> `template-mask-spoke.tsx` (inside `<JobProvider>`). The kickoff does **not** ask to refactor
> `ProcessingStatus` to `useJob()` in 4d-2 — it stays as-is (its own `['/api/jobs', jobId]` poll, the
> 4d-1b state). Out of scope.

### `client/src/App.tsx` — remove `/app` route + `Home` import
- Remove **line 7** `import Home from "@/pages/home";`
- Remove **line 54** `<Route path="/app" component={Home} />` (and the now-orphaned
  `{/* Legacy routes preserved */}` comment at line 53, since `/terms` + `/privacy` below it are
  canonical — I'll re-label or drop the comment so it doesn't mislabel them as legacy).

### `client/src/pages/landing.tsx` — fix the dead `/app` nav link
`landing.tsx:44–49` is `<Link href="/app"> … "Already Signed Up? Start Here" …</Link>`. After `/app` is
removed it would 404. **Proposed:** repoint it to the canonical entry **`/upload`**
(`App.tsx:45-48`: `/` redirects to `/upload`; `/upload` → `UploadPage`). Change is `href="/app"` →
`href="/upload"`; `Link` (wouter) import unchanged. This keeps the CTA functional rather than dead.

---

## 2. Verification plan (run after implementation, before report)

1. **Route-registration grep** — prove only canonical URLs remain:
   ```
   grep -nE 'app\.(get|post|patch|delete)\("/api/(videos|images)/|"/api/ai/(infer|labels)|/internal/mask-processing' server/routes.ts server/index.ts
   ```
   Expected: only `POST /api/videos/:jobId/process` (the intentionally-left line 481) matches `/api/videos`;
   zero `/api/images/upload`, `/api/ai/infer`, `/api/ai/labels`, `/internal/mask-processing`.
   ```
   grep -nE 'masks/:labelId/:n|overlays/:labelId/:n' server/routes.ts
   ```
   Expected: only the **canonical** `…/ai/runs/:runId/masks|overlays/:labelId/:n.png` lines (1553/1604-equiv) remain.
2. **Dangling client imports** — none to deleted files:
   ```
   grep -rn 'pages/home\|components/FileUpload\|href="/app"\|path="/app"' client/src
   ```
   Expected: **zero**.
3. **`npx tsc --noEmit`** — expect **17, or fewer** (home.tsx/FileUpload.tsx carried none of the 17, so
   most likely still exactly 17). If it **drops**, report the new count + which file's errors went. If it
   **rises**, a dangling reference remains → fix before the report. **Never above 17.**

---

## 3. Deliverables & post-merge (per kickoff)

- **This file** (`PHASE_4D2_PROPOSAL.md`) — await approval. **No code yet.**
- After approval → implement → `PHASE_4D2_REPORT.md` with the post-removal route grep proving only
  canonical URLs remain + the final tsc count.
- `CLAUDE.md` — add "Phase 4d-2 landed" (legacy aliases removed; home.tsx/FileUpload/`/app` deleted; only
  canonical URLs registered; **Phase 4 frontend migration COMPLETE**); note tsc if changed; leave the
  flagged AI-spoke canvas-polish backlog + the cosmetic first-paint-progress item intact.
- Deploy (your step): snapshot `pre-phase-4d2-deploy`; smoke every workflow watching Network + server logs
  for 404s/legacy hits; `/app` now 404s (expected); rollback = git revert.

---

## 4. Resolutions (approved)

1. **Row 3 / Note A** — delete `getLegacyJobHandler`'s definition (439–459) in addition to its
   registration (460). grep-confirmed legacy-exclusive (zero non-doc references besides def+registration).
2. **`/api/videos/:jobId/process` (481)** — examined: dead legacy, zero callers (canonical path is
   `/api/jobs/:jobId/template-mask/apply`). Left in 4d-2 (not on the removal list); recorded in CLAUDE.md
   cleanup backlog for later removal.
