# Phase 4d-2 Report — One-way legacy teardown

**Date:** 2026-06-20
**Status:** COMPLETE. Phase 4 frontend migration is now COMPLETE.
**Type:** Irreversible removal (one-way door). Gated by the 4d-1b live-log check
that confirmed zero canonical-app callers on any legacy URL.
**tsc:** 17 before, 17 after (unchanged — 10 `frameExtractor.ts` + 7 `maskWorker.ts`).

Implements `PHASE_4D2_PROPOSAL.md` as approved, plus the two approval-time
conditions (resolved in §4).

---

## 1. Backend — legacy alias registrations removed (`server/routes.ts`)

For each paired alias, only the legacy `app.<method>` registration line was
deleted; the canonical URL line and the shared named handler stay. Every handler
retains its canonical registration → zero dangling references.

| Removed legacy registration | Canonical kept | Handler |
|---|---|---|
| `POST /api/videos/upload` | `POST /api/uploads/video` | `videoUploadHandler` |
| `POST /api/images/upload` | `POST /api/uploads/images` | `imageUploadHandler` |
| `GET /api/videos/:jobId` | `GET /api/jobs/:jobId` | `getLegacyJobHandler` → **definition also deleted** (see §4) |
| `GET /api/videos/:jobId/download` | `GET /api/jobs/:jobId/template-mask/download` | `templateMaskDownloadHandler` |
| `POST /api/ai/infer` | `POST /api/jobs/:jobId/ai/runs` | `aiInferHandler` |
| `PATCH /api/ai/labels/:jobId/:labelId` | `PATCH /api/jobs/:jobId/ai/runs/:runId/labels/:labelId` | `patchLabelHandler` |
| `DELETE /api/ai/labels/:jobId/:labelId` | `DELETE /api/jobs/:jobId/ai/runs/:runId/labels/:labelId` | `deleteLabelHandler` |
| `GET /api/ai/labels/:jobId` | run-scoped list under `/api/jobs/:jobId/ai/runs` | inline handler — **removed whole** (not a paired alias) |
| `GET /api/jobs/:jobId/masks/:labelId/:n.png` | `GET /api/jobs/:jobId/ai/runs/:runId/masks/:labelId/:n.png` | `getMaskHandler` |
| `GET /api/jobs/:jobId/overlays/:labelId/:n.png` | `GET /api/jobs/:jobId/ai/runs/:runId/overlays/:labelId/:n.png` | `getOverlayHandler` |

10 alias removals (11 registration lines including the `GET /api/videos/:jobId`
pairing). The `GET /api/ai/labels/:jobId` case was an inline legacy-only handler
block (~12 lines), removed in full and replaced with a removal-noting comment.

**Doc-comment corrections:** the masks and overlays JSDoc blocks updated to
canonical-only (each notes the labelId-only alias removed in 4d-2); the
template-mask/apply comment updated to drop the reference to the removed
`/internal/mask-processing` wrapper.

## 2. Backend — wrapper + dead import removed (`server/index.ts`)

- Deleted the `PATCH /internal/mask-processing/:jobId` thin wrapper block + its
  3-line comment.
- Deleted the now-dead `import { applyTemplateMask } from "./handlers/templateMaskApply"`.

The shared `applyTemplateMask` function in `server/handlers/templateMaskApply.ts`
stays — it is still used by the canonical `POST /api/jobs/:jobId/template-mask/apply`
registration (`routes.ts:1640`). The stale header comment in `templateMaskApply.ts`
that listed the wrapper as a second call site was corrected to canonical-only.

## 3. Frontend — two files deleted, import-graph verified

- **Deleted `client/src/pages/home.tsx`** — the legacy single-page-app monolith.
- **Deleted `client/src/components/FileUpload.tsx`** — verified home-only (its only
  importer was `home.tsx:3`).
- **`App.tsx`** — removed `import Home from "@/pages/home"` and
  `<Route path="/app" component={Home} />` (+ its "Legacy routes preserved" comment).
- **`landing.tsx`** — CTA `<Link href="/app">` → `<Link href="/upload">`.

All of `home.tsx`'s other imports (notably `ProcessingStatus`) are shared with
canonical spoke pages and were left in place. `/app` now 404s by design.

## 4. Approval-time conditions — resolved

**(A) `getLegacyJobHandler` definition deleted, not just its registration.**
Grep confirmed the only *code* references were the definition and the
`GET /api/videos/:jobId` registration; all other hits were docs. Once the
registration was removed it was legacy-exclusive dead code, so the definition was
deleted too. `getJobV2Handler` + `GET /api/jobs/:jobId` are untouched.
Post-removal grep for `getLegacyJobHandler` → **zero matches**.

**(B) `POST /api/videos/:jobId/process` (routes.ts:454) examined.**
Confirmed **dead legacy with no caller**: no client constructs the URL
(broad `client/src` search = 0), and the canonical processing path used by every
spoke is `POST /api/jobs/:jobId/template-mask/apply` (`ProcessingControls.tsx:85`).
It matches `/api/videos/`, so the empty live legacy sweep already implied no caller.
It was **not** on the 4d-2 alias list, so it was left in place and **flagged in the
cleanup backlog (CLAUDE.md item 16)** as a removal candidate. No unexamined
legacy survivor remains.

## 5. Verification (post-removal)

- **Route grep** (`app.<method>("/api/videos/upload" | "/api/images/upload" |
  "/api/videos/:jobId" | "/internal/mask-processing" | "/api/ai/infer" |
  "/api/ai/labels"`) → only `routes.ts:454 POST /api/videos/:jobId/process`
  (intentionally left, flagged). Zero legacy alias registrations.
- **masks/overlays grep** → only canonical runId-scoped registrations remain
  (`routes.ts:1509`, `routes.ts:1559`).
- **`getLegacyJobHandler` grep** → zero matches (definition + registration gone).
- **`applyTemplateMask` grep** → definition (`templateMaskApply.ts:31`) + canonical
  use (`routes.ts:36` import, `routes.ts:1640` call) only; the `index.ts` import is gone.
- **Client dangling-import grep** (`pages/home | components/FileUpload | href="/app"
  | path="/app"`) → no matches.
- **`npx tsc --noEmit`** → exactly **17** errors (10 `frameExtractor.ts` +
  7 `maskWorker.ts`), identical to baseline. The deleted files carried none of the 17.

## 6. Deploy notes (user's step)

- Snapshot tag `pre-phase-4d2-deploy` before deploy.
- Smoke-test every workflow (upload video, upload images, template-mask apply +
  download, AI run + label approve/delete, mask/overlay PNG fetch).
- `/app` should now **404** — this is expected.
- Rollback = `git revert` of the 4d-2 commit.

## 7. Out of scope (unchanged)

Canonical URLs/handlers, the b734e6d re-entrancy fix, applyPaths, tripwire,
retention, `videoProcessor`/`frameExtractor`/`tempFolderManager`/`frameAccess`,
the AI-spoke canvas-polish bugs, and the broader cleanup backlog were untouched.
The pre-existing 17 `tsc` errors remain on the backlog (item 12).
