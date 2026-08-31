# Round 2A report — frame-0 unblock ("draw while extracting")

**Spec:** `docs/refactor/ROUND2A_FRAME0_UNBLOCK.md` · **Background:** `docs/refactor/FRAME0_GATE_HISTORY.md`
**Landed:** 2026-08-30. **NOT deployed** — handing back for `ROUND2A_DEPLOY_RUNBOOK.md`.

**Gates:** `npx tsc --noEmit` = **12**, and the *same* 12 (5 `frameExtractor.ts` `pixelBuffer` +
7 `maskWorker.ts`). `npm run build` clean. `frameAccess.test.ts` **8/8 pass**. No file under
`server/storage.ts`, `server/pgStorage.ts`, `shared/schema.ts`, or `migrations/` was touched — A3 intact.
Round 1's `[PERF]` probes are untouched and ride along on this deploy.

---

## 1. Files changed

| File | Lines | What |
|---|---|---|
| `server/services/frameAccess.ts` | +39 | `isCompletePngBuffer` ([:187](server/services/frameAccess.ts:187)) and `isCompletePng` ([:197](server/services/frameAccess.ts:197)) — the IEND completeness guard |
| `server/services/__tests__/frameAccess.test.ts` | **new**, 8 tests | red/green cover for the above |
| `server/routes.ts` | +66/−9 | frames endpoint raw branch rewritten ([:1613-1657](server/routes.ts:1613)) |
| `client/src/contexts/JobContext.tsx` | +22/−5 | expose the granular `progress` payload it was already receiving ([:19](client/src/contexts/JobContext.tsx:19), [:73](client/src/contexts/JobContext.tsx:73)) |
| `client/src/pages/hub.tsx` | +20/−3 | `canMask` ([:55](client/src/pages/hub.tsx:55)), tile `disabled={!canMask}` ([:181](client/src/pages/hub.tsx:181)), optional `subLabel` on `SpokeTile` ([:214](client/src/pages/hub.tsx:214)) |
| `client/src/pages/template-mask-spoke.tsx` | +99/−15 | frame-0 polling ([:115-135](client/src/pages/template-mask-spoke.tsx:115)), `framesReady` ([:36](client/src/pages/template-mask-spoke.tsx:36)), Apply gating ([:151](client/src/pages/template-mask-spoke.tsx:151)) |
| `client/src/components/ProcessingControls.tsx` | +20/−3 | optional `extractionNote` prop rendered under the Apply button ([:29](client/src/components/ProcessingControls.tsx:29), [:287](client/src/components/ProcessingControls.tsx:287)) |

`CLAUDE.md` also shows as modified — that predates this session; I did not edit it.

### 1.1 Backend — the raw branch (§3.1)

Old: `if (status === 'extracting') return 503` **before** the directory was ever listed. New: list
first, then ask the only question that still matters — is *this* frame on disk and whole?

```ts
const { dir: rawDir, files: rawFiles } = await listRawFrameFiles(jobId);

if (jobV2.status === 'extracting') {
  if (frameNumber < rawFiles.length) {
    const partial = await fsPromises.readFile(path.join(rawDir, rawFiles[frameNumber]));
    if (isCompletePngBuffer(partial)) { /* 200, private max-age=3600 */ }
  }
  res.set("Cache-Control", "no-store");
  return res.status(503).json({ error: "Extraction in progress", framesReady: rawFiles.length });
}
// ready / failed: 410 empty → 404 out of range → 200. Byte-for-byte the pre-2A code.
```

- `?source=template_mask` branch: **untouched.**
- 410 (swept) and 404 (out of range) semantics: **untouched**, and still unreachable while extracting
  — mid-extraction "not there yet" is a 503, which is what it always meant.
- Cache headers: 200 keeps `private, max-age=3600`; the 503 sends `no-store` so a browser can never
  replay "extracting" after extraction finishes.

**One read, not two.** The spec's `isCompletePng(path)` would have meant reading the file to check
the trailer and then reading it again to send it. The route calls the **buffer** form on the read it
already performs. `isCompletePng(path)` still exists with the specced signature — it is what the test
drives, and it delegates to the buffer form, so the two can't drift.

### 1.2 Frontend

**Hub** — `canMask = isReady || isExtracting` gates the Template Mask tile; the AI tile keeps
`disabled={!isReady}` verbatim. While extracting (and before a mask exists) the tile carries a second
line: *"Frame 1 ready — draw your mask while frames extract."* The "Extracting frames…" panel stays.

**Spoke** — on 503 it reads `framesReady` from the body and polls `frames/0` every 1000 ms until a
200, capped at 120 s, then falls to the existing error state. The interval is cleared on unmount and
on success. The "refetch when `job.status` becomes `ready`" effect is kept as the belt-and-braces path.

**Apply gating** — `disabled={!jobId || !maskData || !canApply}` where `canApply = job.status === 'ready'`,
with a live note under the button. When status flips to `ready` the note disappears and the button
enables with no reload — `JobContext` already refetches on the `progress` event and polls every 2 s
while non-terminal.

---

## 2. Deviations from the spec — and why

1. **`JobContext` now exposes `progress`; the spoke does not open its own socket.** §3.4 says the
   note should be "driven by the `progress` socket event `JobContext` already joins (5D)" — but
   `JobContext` was *discarding* that payload after calling `refetch()`, so there was nothing for a
   consumer to read. The alternative was a third `useWebSocket()` in the spoke (`JobContext` and
   `ProcessingStatus` already hold one each), i.e. a third socket connection per page view for a
   payload the page was already receiving. Surfacing it on the context is ~6 additive lines, changes
   no existing behavior, and is not a new backend progress source. Fallback order for the note is
   exactly as specced: socket `currentFrame` → `framesReady` from the last 503 → bare
   "Extracting frames…".

2. **`extractionNote` is a new optional prop on `ProcessingControls`, not spoke-side markup.** §3.4
   said "next to/under the button", and the button lives inside `ProcessingControls` under `mt-auto`.
   One optional prop, defaulting to `null`, puts the text where the spec asked. It also suppresses
   the "Change output size… to re-process" hint while extracting, which would otherwise contradict a
   disabled button.

3. **Replaced the spoke's 3 s `refetch()` interval rather than adding alongside it.** That interval
   polled the *job record*, which `JobContext` already polls every 2 s while non-terminal — it was
   redundant before this change and would have been pure duplicate load next to the new 1 s frame
   poll. The status-transition retry effect it was backstopping is untouched.

4. **Two bugs found and fixed in my own first cut of the poll**, noted here because they are the kind
   that survive review: (a) the 120 s deadline was reset whenever `frameStatus` left `"extracting"`,
   and since a retry passes through `"loading"`, the cap would have re-armed every tick and never
   fired; the deadline is now cleared only on `"ready"`. (b) each poll tick set `"loading"`, bouncing
   the view between the waiting screen and the canvas spinner once a second; polls now run in a
   `silent` mode that leaves the current state alone until it has something better to say.

5. **The spec's §4 row 1 prediction does not match what the code will do — see §3 below.** This is
   the one place I am reporting a divergence rather than implementing one.

### Confirmed not in scope (§3.5), and not touched
Orphan base64 `firstFrame` in the upload response · any extraction/apply/DICOM perf change ·
deleting `maskWorker.ts` · `temp_extracted/` 6 h retention and the 410 path.

---

## 3. Edge-case table (§4), each row walked in source

| # | Case | Expected per spec | Verdict |
|---|---|---|---|
| 1 | Server restart mid-extraction | "Apply never enables. Spoke shows spinner then the 120 s cap → error state." | ⚠️ **verified-in-code — spec expectation is wrong in the common sub-case. ACCEPTED AS-IS** (operator, 2026-08-30) → **cleanup backlog item 18**. See below. |
| 2 | Extraction fails (`status: 'failed'`) | Hub unchanged; spoke's existing error UX | ✅ **verified-in-code.** `canMask` is false for `'failed'` ([hub.tsx:55](client/src/pages/hub.tsx:55)) — identical to today's `!isReady`. The route falls to the ready/failed branch, so 410/404/200 are byte-for-byte pre-2A. |
| 3 | `temp_extracted/<jobId>/` swept while spoke open | 410 path unchanged | ✅ **verified-in-code.** Sweeping only happens ≥6 h after upload, by which point status is `ready`/`failed`, so the read takes the unchanged branch and empty dir → 410. |
| 4 | Image batch job | `ready` at upload; nothing changes | ✅ **verified-in-code.** The image upload handler writes `status: 'ready'` on both the VideoJob and the V2 Job record, so `isReady` is true from the start: `canMask` true, `canApply` true, no note. |
| 5 | DICOM single-frame | 1 frame, `ready` almost immediately | ✅ **verified-in-code.** One batch, one write, then `ready`. Nothing observable changes. |
| 6 | DICOM multiframe | per-frame loop writes `frame_000001.png` first; canvas appears early | ✅ **verified-in-code.** `startBackgroundFrameExtraction` writes in batches of 15 regardless of source, so frame 1 lands after the first batch on both paths. Round 1's `bg_extract.first_frame_on_disk` probe will put a number on how early. |
| 7 | User draws, then extraction finishes | mask state is client-side; nothing resets | ✅ **verified-in-code.** `maskData` is spoke-local `useState`; the `ready` transition only re-runs `fetchFirstFrame` when `frameStatus === "extracting"`, which it no longer is once the canvas is up. Nothing clears the mask. |
| 8 | User hits Apply the instant it enables | apply reads `temp_extracted` after `ready`; no new race | ✅ **verified-in-code.** Unchanged: `status: 'ready'` is written after the batch loop, and `processVideo` re-extracts from the original upload into `_apply/` anyway — it never reads the background frames. No new race. |

### Row 1 in detail — the one divergence

`temp_extracted/` is **not** purged at boot (only `uploads/` and `temp_processed/` are), and job
status is durable in Postgres since 5C-2 with no startup reconciliation of stale `extracting` jobs.
So after a restart mid-extraction there are two distinct sub-cases:

- **At least one batch had completed** (the common case — batches are 15 frames). `frame_000001.png`
  is on disk and whole, so the new endpoint **serves it: 200, canvas opens, the user can draw.** The
  120 s cap is never reached because nothing is waiting. Apply stays disabled forever with
  "Extracting frames…" under it, since status never reaches `ready`. The spec predicted a spinner
  then an error; the user actually gets a working canvas that leads nowhere.
- **The restart landed before the first batch.** Directory empty → 503 → poll → 120 s cap → error
  state, exactly as the spec describes.

The first sub-case is a **dead end with no error message**, and it is *new* — today the hub tile is
disabled so the user never gets in. It is not a regression of anything that works (the upload was
purged at boot, so Apply could never have succeeded for that job either way).

**Decision (operator, 2026-08-30): accepted as-is for Round 2A.** No code change; logged as
**cleanup backlog item 18** in `CLAUDE.md`, with the two candidate fixes recorded there — (a) a
startup reconciliation pass marking stale `'extracting'` jobs `'failed'` (touches status semantics,
so A3-adjacent, needs its own gate), or (b) a client-side staleness timeout in the spoke. Neither is
scheduled. Nothing in the runbook needs to change for it; if it shows up during testing it is
expected behavior, not a bug to chase.

---

## 4. What is NOT verified here

This box has no ffmpeg and no Postgres, so the endpoint could not be exercised end-to-end — the raw
branch is verified by reading, by `tsc`, and by the completeness-guard unit test, not by an HTTP
round trip. The behaviors that need eyes on the box, in the order the runbook should hit them:

1. Upload a large MP4 → click Template Mask **immediately** from the hub → canvas paints frame 1
   while `ProcessingStatus` below it still counts up.
2. Apply is disabled, with "Extracting frames… N / M" under it, and the count moves.
3. Apply enables **without a reload** when extraction completes; applying and downloading still work.
4. Draw a mask mid-extraction, wait for `ready`, then apply — the mask must survive (row 7).
5. Both DICOM cases still open and apply (rows 5–6).
6. DevTools: the 503 carries `Cache-Control: no-store`, the 200 carries `private, max-age=3600`.

`docs/refactor/ROUND2A_DEPLOY_RUNBOOK.md` §5 also collects the Round 1 `[PERF]` numbers on the same
session — worth doing in one sitting, since this is the deploy that carries both.
