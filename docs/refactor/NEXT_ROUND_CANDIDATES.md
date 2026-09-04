# Masquerade — next round: 5 candidate work items with Claude Code plans

Drafted 2026-09-04, against `main` @ `21e588b` (PERF/UX round complete, deployed 2026-08-30).

**Source of truth for the backlog:** `CLAUDE.md` → "Post-refactor cleanup backlog" (items 1–26) and
"Backlog opened by this round". `.claude/` in the repo holds only a stale git worktree
(`claude/agitated-bohr-fd0447`) — no notes there.

## Standing invariants every plan below must hold

| Invariant | Value | Where it breaks |
|---|---|---|
| `tsc --noEmit` errors | **12** (5 `frameExtractor.ts`, 7 `maskWorker.ts`) — only Item 4 may change it | `npx tsc --noEmit` |
| A3 storage model | **FROZEN** — no schema/status/column change | `shared/schema.ts`, `server/storage.ts`, `server/pgStorage.ts`, `migrations/` |
| Frame indexing | masked = **0-indexed** `.jpg`/`.png`; raw = **1-indexed** `.png` | `frameAccess.resolveFramePath`, `temp_extracted/` |
| Apply reuse guard | `samplingFps == null` + `status==='ready'` + on-disk count `=== totalFrames` + IEND-complete | `tryReuseRawFrames` |
| Deploy | one item = one deploy = one `git revert` | `deploy.sh`, EBS snapshot first |

Each item below ends with a **kickoff prompt** — paste it into Claude Code as-is.

---

## Item 1 — Image-batch output mislabel (correctness bug)

*Backlog item 22. Smallest real bug on the list; mirror of the video-path bug already fixed in the 2B addendum.*

**Why.** `processImages` unconditionally encodes PNG (`videoProcessor.ts:2059`,
`await processedImage.png().toBuffer()`), but `TempFolderManager.saveProcessedImage`
(`templateMaskFolderManager.ts:84`) names the output from the *uploaded* file's extension. A masked
`photo.jpg` is written as PNG bytes in a file called `image_001_photo.jpg`. Anything downstream that
trusts the extension — the ZIP consumer, a labeling tool, `mimeForFrameFile` — is being lied to. The
video path was fixed in Round 2B; this path was deliberately left because fixing it changes output
bytes for existing image jobs.

**Where.** `server/services/videoProcessor.ts` (`processImages`, ~`:747–960`; encoder at `:2059`),
`server/services/templateMaskFolderManager.ts:78–92`, plus the ZIP/download and manifest readers
(`server/handlers/frameManifest.ts`, `listFrameFiles`/`mimeForFrameFile` in `frameAccess.ts`).

**Plan.**
1. Recon: confirm every write path for image batches — the 3D/volume branch (`:865`) and the fallback
   branch (`:929`) both call `saveProcessedImage`. Confirm `processFrame` at `:2059` is the only
   encoder on the image path (the video path already honors `outputSettings.format` at `:1783–1787`).
2. Make the image encoder follow `outputSettings.format` exactly as the video path does:
   `format === 'png'` → `.png({ compressionLevel: 3, adaptiveFiltering: false })`, else
   `.jpeg({ quality: 90 })`. Same defaults, same constants — do not invent new ones.
3. Make `saveProcessedImage` take the actual output format and derive the extension from it, keeping
   the original basename: `image_001_photo.jpg` / `image_001_photo.png` by *content*, not by upload.
   Signature change is additive (new required arg at call sites, both updated).
4. Sweep readers: `listFrameFiles` already accepts `png|jpg|jpeg` and `mimeForFrameFile` derives the
   type — verify the image path goes through them and not a hardcoded `.png` anywhere
   (`grep -rn "\.png'" server/handlers server/services | grep -i image`).
5. Note the behavior change in `CLAUDE.md` (backlog item 22 → DONE) with the one-line reason.

**Gates / risk.** Default output for image jobs becomes JPEG bytes in a `.jpg` file — a *byte* change
versus today for any upload that wasn't already `.png`. That is the intended fix, but it means old
image jobs on disk keep the old mislabeled naming; do not attempt to migrate them.

**Verification.** Upload a 3-image batch (`.jpg`, `.jpeg`, `.png` mixed), apply a mask, then on the
box: `file spokes/template_mask/<jobId>/*` — every reported type must match its extension. Repeat
with the PNG option selected in the UI. Download the ZIP and confirm it opens. `tsc` stays 12.

**Rollback.** Single commit, `git revert`.

**Kickoff prompt**
> Read `CLAUDE.md` (backlog item 22) and `docs/refactor/ROUND2B_REPORT.md` §A first. Fix the
> image-batch output mislabel: `processImages` always encodes PNG (`videoProcessor.ts:2059`) while
> `TempFolderManager.saveProcessedImage` (`templateMaskFolderManager.ts:84`) names the file from the
> upload's extension. Make the image encoder honor `outputSettings.format` using exactly the same
> constants as the video path (JPEG q90 default, PNG compressionLevel 3 opt-in), and derive the saved
> filename's extension from the actual output format. Update both call sites (`:865`, `:929`). Do not
> touch the video path, `shared/schema.ts`, `storage.ts`, `pgStorage.ts`, or `migrations/`; `tsc
> --noEmit` must stay at 12. Give me a proposal with the exact diff before writing it, then a short
> report with a `file`-command verification plan.

---

## Item 2 — "Review masked frames" inside the template-mask spoke (UX gap)

*Backlog item 20. The highest user-visible value on the list, and the recon says it is mostly wiring.*

**Why.** After Apply, there is no way to look at the result without downloading the ZIP or detouring
through the AI spoke. That is the single worst moment in the current flow — you mask PHI and then
have to leave the app to check whether the mask actually covered it.

**Why it's cheap.** `GET /api/jobs/:jobId/frames/:n.png` already resolves out of
`SPOKE_TEMPLATE_MASK_DIR` via `resolveFramePath` and already derives Content-Type from the file
extension (2B addendum §A.2). `FrameViewer` in **Clean** mode fetches exactly that URL (`:225`) and
its `viewer-info`/`inference.json` calls degrade correctly with zero AI runs (`labels: []`,
`hasInference: false`). So the backend work is plausibly **zero**.

**Where.** `client/src/pages/template-mask-spoke.tsx`, `client/src/components/FrameViewer.tsx`
(props at `:60–64`), `client/src/App.tsx` (routing), reference implementation at
`client/src/pages/ai-spoke.tsx:320`.

**Plan.**
1. Recon first, and report before coding: hit `/api/jobs/<masked-job>/viewer-info` and
   `/inference.json` for a template-mask-only job (no AI run) and record the actual responses. If
   either 404s/500s on a job with no `aiLabels`, that is the one backend change — make it degrade,
   don't add an endpoint.
2. Add a review surface in the spoke, gated on `job.templateMask.status === 'complete'`: a "Review
   masked frames" action next to Download that mounts `FrameViewer` (Clean mode) for the job.
   Prefer a route (`/jobs/:jobId/template-mask/review`) over a modal so it's linkable and back-button
   sane; follow the ai-spoke mount as the pattern.
3. Force mode to `clean` and hide the Overlay/Bbox toggles when `hasInference === false` — no
   dead affordances. Do NOT touch the AI-spoke usage of the same component; scope with a prop
   (`allowedModes` or similar), defaulting to today's behavior.
4. Handle the three existing states the spoke already models: `410` frames swept → the existing
   "no longer available" panel; `404` → not found; retention message consistent with the viewer's.
5. `onContinueToDownload` wires to the existing template-mask download, not the AI download.

**Gates / risk.** Frontend-only if step 1 comes back clean. `FrameViewer` is shared — any change to
it must leave the AI spoke byte-identical in behavior; verify both spokes after.

**Verification.** Mask a 348-frame clip → Review → scrub end to end, confirm frame 0 and frame N-1
render and that frame *i* in the viewer matches `spokes/template_mask/<jobId>/frame_%06d` at base 0
(the off-by-one trap). Then open the AI spoke on a job with runs and confirm nothing regressed.
Re-check after the 6 h retention sweep window that 410 renders the right panel.

**Rollback.** `git revert`; frontend-only, no data implications.

**Kickoff prompt**
> Read `CLAUDE.md` (backlog item 20 + "Frame viewer" section) first. Goal: let the user review masked
> frames inside the template-mask spoke instead of downloading the ZIP or detouring to the AI spoke.
> Step 1 is recon, and stop there for my sign-off: verify that `/api/jobs/:jobId/viewer-info`,
> `/inference.json`, and `/frames/:n.png` all behave for a job with a completed template mask and NO
> AI runs, and report the actual responses. Then propose a frontend-only plan that mounts
> `FrameViewer` in Clean mode from `template-mask-spoke.tsx` (pattern: `ai-spoke.tsx:320`), gated on
> `job.templateMask.status === 'complete'`, hiding Overlay/Bbox when `hasInference` is false, without
> changing AI-spoke behavior. Masked frames are 0-indexed — state how you verified the viewer's frame
> *i* is the file at base 0. `tsc` stays 12; no A3 files touched.

---

## Item 3 — Stale `extracting` job left as a silent dead end (reliability)

*Backlog items 18/21. Accepted as-is on 2026-08-30; worth closing now that Round 2A opened the canvas.*

**Why.** If the server restarts mid-extraction after at least one batch landed, the frames endpoint
correctly serves `frame_000001.png`, the hub tile opens, the canvas paints, the user draws — and
Apply never enables, because `status` never reaches `ready` and nothing reconciles it. No error, ever.
The upload was purged at boot (`index.ts:125–126` purges `uploads/`, not `temp_extracted/`), so the
job genuinely cannot be completed; the UI just doesn't say so.

**Where.** `server/index.ts:127–142` (boot sequence), `server/services/cleanup.ts`,
`client/src/pages/template-mask-spoke.tsx:94–151`, analysis in `docs/refactor/ROUND2A_REPORT.md` §3.

**Two candidate fixes — do (b) first, propose (a) separately.**

- **(b) client-side staleness timeout** *(recommended first; client-only, cheap, no status semantics).*
  In the spoke, when `job.status === 'extracting'` and neither `framesReady` nor the socket
  `progress` payload has advanced for N minutes (start at N = 3, make it a named constant), surface
  "Extraction stalled — the server may have restarted. Re-upload this file." with a re-upload action.
  Must key off *movement*, not elapsed time — a legitimately slow 2000-frame clip must not trip it.
- **(a) startup reconciliation pass** *(server; needs its own gate).* At boot, before `listen`, mark
  jobs whose `status === 'extracting'` as `failed` with a reason. **This touches status semantics and
  needs a new "list jobs by status" read path — neither `IStorage` nor `PgStorage` has one today
  (`pgStorage.ts` only ever selects `where(eq(jobs.id, …))`), so it is A3-adjacent and must be
  proposed, not just written.** Constrain it: read-only query + `updateVideoJob` through the existing
  mirror, no schema change, no new column; skip any job whose `temp_extracted/<jobId>/` count already
  equals `totalFrames` (that one could be reconciled to `ready` instead — decide explicitly, don't
  guess).

**Verification.** Reproduce first: upload a long clip, `pm2 restart masquerade` after ~20 frames land,
open the spoke. Today: canvas opens, Apply disabled forever. After (b): stall banner within N minutes.
After (a): job shows `failed` and the hub tile says so. Confirm a genuinely slow extraction (large
DICOM) does **not** trip either path.

**Rollback.** (b) frontend revert. (a) revert the boot hook — no data migration, since it only writes
a status the app already models.

**Kickoff prompt**
> Read `CLAUDE.md` backlog item 18 and `docs/refactor/ROUND2A_REPORT.md` §3 first. Problem: after a
> restart mid-extraction, Round 2A lets the user into a canvas whose Apply never enables, with no
> error. Implement fix (b) only: a client-side staleness detector in `template-mask-spoke.tsx` that
> keys off *lack of movement* in `framesReady`/socket progress (not wall-clock since load) and shows a
> "extraction stalled, re-upload" state after a named-constant timeout. Then, separately and as a
> written proposal I must approve before any code, scope fix (a) — a boot-time reconciliation pass
> marking stale `extracting` jobs `failed`. Note in the proposal that no list-by-status read path
> exists in `IStorage`/`PgStorage` today and that A3 is frozen, and say exactly what you would add.
> `tsc` stays 12.

---

## Item 4 — Delete `maskWorker.ts`, then narrow the remaining 5 tsc errors (code health)

*Backlog items 23 + 12 / 7A-5 remainder. The only sanctioned path to move the tsc baseline.*

**Why.** `server/services/maskWorker.ts` is dead — nothing in `server/` or `client/` imports
`MaskWorkerPool` (re-verified: `grep -rn "maskWorker" server client` returns nothing outside the file
itself). It carries **7 of the 12** tsc errors. Deleting it takes the baseline 12 → 5 in one commit
that cannot change runtime behavior. The remaining 5 are `pixelBuffer` narrowings in
`frameExtractor.ts` — real type work that may expose latent image-processing bugs, which is exactly
why 7A-5 deferred them.

**Where.** `server/services/maskWorker.ts` (delete), `server/services/frameExtractor.ts` (5 errors),
`CLAUDE.md` (the tsc=12 invariant statement, in three places — Constraints, item 12, item 23).

**Plan — two commits, in this order, do not merge them.**
1. **Commit A (mechanical).** Re-verify dead: grep source, and grep the built bundle
   (`dist/`) for `MaskWorkerPool`. Delete the file. `npx tsc --noEmit` must print exactly 5 errors,
   all in `frameExtractor.ts`. Rebuild, confirm the bundle still builds. Update the invariant in
   `CLAUDE.md` from 12 to 5 everywhere it is stated.
2. **Commit B (real type work).** Narrow the 5 `pixelBuffer` errors in `frameExtractor.ts`.
   **No blanket `@ts-expect-error`, no `as any`.** For each: state what the type actually is at
   runtime and why the narrow is sound. If any one of them looks like it is papering over a real
   nullable/shape bug, stop and report instead of suppressing — that is the outcome 7A-5 was worried
   about, and finding one is a success, not a blocker.

**Gates.** Commit A only lands if tsc goes exactly 12 → 5 and the build succeeds. Commit B only lands
with a per-error justification and a DICOM + MP4 extraction smoke test, since `frameExtractor.ts` is
the file that carried the DICOM apply-path regression once already.

**Verification.** Extract + apply on (1) the MP4 reference clip `Normal Lung sliding 2.mp4`,
(2) a single-frame DICOM, (3) a multiframe DICOM. `bg_extract.done` parity/corrected fields unchanged;
`apply.source: reuse` still fires on the MP4.

**Rollback.** Two independent reverts.

**Kickoff prompt**
> Read `CLAUDE.md` backlog items 12 and 23 and the Phase 7A report's deferred-items section first.
> Two separate commits, do not combine them. Commit A: re-verify `server/services/maskWorker.ts` is
> dead (grep source *and* the built bundle for `MaskWorkerPool`), delete it, confirm `npx tsc
> --noEmit` goes from exactly 12 errors to exactly 5 (all `frameExtractor.ts`), rebuild, and update
> the tsc invariant everywhere `CLAUDE.md` states it. Stop and show me Commit A before starting B.
> Commit B: narrow the 5 remaining `pixelBuffer` errors in `frameExtractor.ts` with a per-error
> justification of what the runtime type actually is — no `@ts-expect-error`, no `as any`; if any one
> of them is hiding a real bug, stop and report instead of suppressing. `frameExtractor.ts` is the
> file that carried the DICOM regression, so include an MP4 + single-frame DICOM + multiframe DICOM
> smoke plan. A3 files stay untouched.

---

## Item 5 — Close the two open 7B one-way doors (evidence-gated cleanup)

*Backlog items 4 and 16 / Phase 7B-1 and 7B-3. Both have been sitting on "watch prod during testing" since 2026-07-22.*

**Why.** These are the last two items parked on evidence rather than on work, and the evidence window
has now been open for ~6 weeks. Either the gates have passed and both deletions are free, or they
haven't and we should say so and stop re-listing them.

- **7B-1 — remove `POST /api/videos/:jobId/process`.** Static sweep found zero callers; the live path
  is `POST /api/jobs/:jobId/template-mask/apply`. A `[DEADROUTE-HIT]` instrument is live at
  `server/routes.ts:496`. **Gate:** zero hits in prod logs across the observation window, plus a clean
  source *and bundle* grep. HTTP 200 is not proof — the SPA catch-all answers everything.
- **7B-3 — drop `TEMP_PROCESSED_DIR` from `SWEEP_TARGETS`** (`cleanup.ts:68`) and delete
  `purgeTempProcessedOnStartup` (`cleanup.ts:328`, called from `index.ts:137/140`). **Gate:**
  `temp_processed/` empty for ≥7 continuous days under real use.

**Evidence commands (run these on the box first — this is step 0, before any code):**
```
pm2 logs masquerade --lines 200000 --nostream --raw | grep -c '\[DEADROUTE-HIT\]'
ls -la temp_processed/ ; find temp_processed -type f | wc -l
find temp_processed -type f -newermt '-7 days' | head
```

**Plan.**
1. Collect the evidence above and write the result into the report *before* touching code. If
   `[DEADROUTE-HIT]` fired even once, 7B-1 is dead on arrival — record what called it and stop.
2. If clean: delete the handler **and** its `[DEADROUTE-HIT]` instrument in one commit; re-grep
   `client/src` and `dist/` for the URL string.
3. If `temp_processed/` is empty and unwritten: remove it from `SWEEP_TARGETS`, delete
   `purgeTempProcessedOnStartup` and its two call sites, and leave the directory itself alone
   (deleting the dir is a separate decision).
4. **Leave 7B-2 and 7B-4 alone.** 7B-2's target reference is stale and was never re-confirmed; 7B-4
   (whole-job download 404 when no mask was applied, `routes.ts:552–554`) is your call, and the
   Phase 7 proposal recommends leaving it documented.

**Verification.** After deploy: upload → apply → download on prod, watch the boot log for the removed
purge line's absence, and confirm the hourly sweep still logs its other five targets.

**Rollback.** Two independent reverts; both are deletions of code with no callers, so revert restores
byte-for-byte.

**Kickoff prompt**
> Read `docs/refactor/PHASE_7_PROPOSAL.md` §7B and `CLAUDE.md` backlog items 4 and 16 first. Step 0 is
> evidence, not code: I will run the log/dir commands on prod and paste the output — tell me exactly
> what you need. Given clean evidence, execute 7B-1 (delete `POST /api/videos/:jobId/process` and its
> `[DEADROUTE-HIT]` instrument at `routes.ts:496`, then re-grep `client/src` and `dist/` for the URL)
> and 7B-3 (drop `TEMP_PROCESSED_DIR` from `SWEEP_TARGETS` at `cleanup.ts:68` and delete
> `purgeTempProcessedOnStartup` plus its two call sites in `index.ts`) as two separate commits. If the
> evidence is not clean, write that up and stop — do not remove anything. Do not touch 7B-2 or 7B-4.
> `tsc` stays 12; A3 frozen.

---

## Considered and not picked

| Item | Why not now |
|---|---|
| 19 — grayscale raw frames (2B-3c) | Real remaining lever (~3× disk on `temp_extracted/`), but Round 2C established ~8 s is the decode/encode floor on this box. Experiment-only; do it when disk or a PNG-lossless option actually bites. |
| 24 — stack scheduling vs libuv pool | Maybe ~2× left in the 8 s apply. Diminishing, and apply time is no longer the complaint. |
| 13 / 7A-6 — Vite chunk split | 661 KB bundle. Deliberately deferred as the wrong thing to introduce during a testing period; nothing has changed. |
| 15 / 7B-4 — download 404 with no mask applied | Operator decision, not engineering. Proposal recommends leaving it documented. |
| 26 — usage/tier model | Product design, no design yet; frames × resolution × format are already on the job record when you want it. |
| 25 — `ANTHROPIC_API_KEY` unset on prod | Not a code task — set a valid key in the PM2 env (`pm2 delete` + fresh start, since the daemon caches env; see `PHASE_5C2_ENV_MISMATCH_HANDOFF.md`). ~5 minutes, worth doing before the next testing session so the intent parser stops falling back to the keyword path. |

## Suggested order

**1 → 4A → 2 → 3b → 5**, then 4B. Item 1 is a contained correctness fix and a good warm-up; Commit A
of Item 4 is mechanical and makes every later diff quieter; Item 2 is the one users will feel; Item 3b
removes the only silent dead end in the flow; Item 5 clears the parked gates. Item 4's Commit B is
last because it is the only one that can surface a latent image-processing bug.
