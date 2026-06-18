# Phase 4b-0 FOLLOW-UP — Persistent raw-frame auto-delete: PROPOSAL

**Status:** Investigation complete. **Awaiting approval before any code change.**
**Scope guard honored:** `b734e6d` untouched, no retention/`SWEEP_TARGETS` change, no
`global.extractedFrames`, no PHI weakening, backend-only, `tsc` stays at 17.

---

## 0. Headline (read this first)

The kickoff asked me to identify **the actual deleting line (file:line) and its
trigger — not a guess**, and explicitly authorized the alternative:

> "If you cannot find a single deleting line and suspect it's elsewhere (e.g. an
> external process, a misconfigured sweep, a race), say so explicitly with the
> evidence."

**That is the outcome.** After an exhaustive trace of the deployed source
(`b734e6d` = `origin/main` = working tree = the freshly-built `dist/index.js`),
**there is no line in the current/deployed application code that deletes the
persistent `temp_extracted/<jobId>/frame_*.png` set within ~1s of extraction on a
plain upload, with no user action and no log.** Every delete that *can* touch
`temp_extracted/` is accounted for below, with its trigger, and **none matches the
production signature**.

The kickoff's "immediate-delete remnant" hypothesis is **refuted for the current
source** (git evidence in §3): that remnant existed pre-4b-0, in the *apply*
path's `finally`, and was already narrowed to the `_apply` leaf by 4b-0 / FIX V2.

So the deleter is **not in the current TypeScript source**. The evidence points to
an **out-of-process deleter** (host cron / external sweeper / ephemeral mount) or a
**stale deployed binary**, ranked in §4. The principled fix (§5) is the
instrumentation the kickoff already mandates — which **doubles as the live
diagnostic that will name the real culprit on the next upload**.

I am explicitly **not** "just removing a delete" (a kickoff red flag): there is no
single delete to remove, and removing the legitimate `_apply`/job-delete cleanups
would corrupt the redo loop or leak PHI.

---

## 1. Complete enumeration — every delete that can touch `temp_extracted/`

The deleting primitive is `safeDelete(absPath, allowedRoot)` at
`server/services/cleanup.ts:100` (`await fs.rm(target, { recursive, force })`).
It is **silent on success** by design. Every caller that can reach
`temp_extracted/` (or a child):

| # | Caller (file:line) | What it deletes | Trigger | Logs on success? | Fits "~1s, every upload, no action, no log, whole-dir GONE"? |
|---|---|---|---|---|---|
| 1 | `cleanupJobArtifacts` → `safeDelete` `cleanup.ts:145` | **whole** `temp_extracted/<jobId>` (+ spokes, temp_processed) | **only** `DELETE /api/jobs/:jobId` `routes.ts:1868` and `scripts/cleanup-now.ts --job` | **No** (warns on failure only) | **No** — requires an explicit DELETE call; no client/auto caller exists |
| 2 | `sweepDirectory` → `safeDelete` `cleanup.ts:215` | a child entry of `TEMP_EXTRACTED_DIR` older than `maxAgeMs` | hourly cron `'0 * * * *'` (age ≥ 6h) `cleanup.ts:351`; `SIGTERM` with `maxAgeMs=0` `routes.ts`; `cleanup-now` | **Yes** — `🧹 sweepDirectory …` `cleanup.ts:224` | **No** — cron skips a seconds-old dir (`ageMs < maxAgeMs` → `continue` `cleanup.ts:189`); `maxAgeMs=0` only via SIGTERM/CLI, which log |
| 3 | `cleanupApplyStaging` → `safeDelete` `applyPaths.ts:100` | **only** the `_apply` **leaf** `temp_extracted/<jobId>/_apply` | `processVideo` (apply) via `prepareCleanApplyStaging` `videoProcessor.ts:328` and `finally` `videoProcessor.ts:482` | No | **No** — (a) apply = user action; (b) it is **leaf-bounded** and *cannot* remove the parent `frame_*.png` (asserted + tested in `b734e6d`), so it can never produce "dir: GONE" |
| 4 | `deleteUploadFile` `cleanup.ts:118` | `uploads/<hash>` | upload `.catch` / abort / error path | No | **No** — wrong directory (uploads, not temp_extracted) |
| 5 | `purgeTempProcessedOnStartup` `cleanup.ts:310` | `temp_processed/*` | boot only | Yes (`🧹`) | **No** — wrong directory, boot-time only |
| 6 | `safeDelete(matchedRun.outputDir, SPOKE_AI_DIR)` `routes.ts:1222,1759` | `spokes/ai/<jobId>/<runId>` | AI run delete (user) | No | **No** — wrong directory (spokes/ai) |

`startBackgroundFrameExtraction` (`videoProcessor.ts:1094`) — the function that
writes the frames and logs `🎉 BACKGROUND EXTRACTION COMPLETE: … frames written to
…` (`videoProcessor.ts:1176`) — **deletes nothing after that log.** It sets
`status: 'ready'` and returns. Confirmed line-by-line.

**Conclusion of §1:** the only two deletes that can remove the *whole*
`temp_extracted/<jobId>` (rows 1, 2) are gated on an explicit `DELETE` request or
on age/SIGTERM — neither fires ~1s after a plain upload, and row 2 always logs.
The only post-extraction delete in the upload→apply flow (row 3) is leaf-bounded
and cannot delete the persistent frames. **No current-source line matches.**

---

## 2. Why "no log line" is the decisive clue (and what it actually implies)

The kickoff reasoned: no log ⇒ old code predating instrumentation. The evidence
inverts that conclusion. In the current source **every in-process delete either
logs (sweep, startup purges) or is reachable only by an explicit user/CLI action
(job-delete, apply-cleanup)**. A delete that fires automatically, on every upload,
with **zero output in `pm2 logs masquerade`**, is therefore most consistent with a
deleter that is **not the pm2 application process at all** — its stdout never
reaches the app's log stream. That reframes "no log" from "old in-app code" to
"**out-of-process deleter**" (§4, candidate A).

---

## 3. The "immediate-delete remnant" hypothesis — refuted for current source (git evidence)

The original immediate-delete **did** exist, exactly as the kickoff's product
history recalls — but git shows it was the **apply path's** `finally`, and it was
**already reconciled** before this task:

- **Pre-4b-0** (`54487d3` and earlier), `processVideo.finally` deleted the **whole**
  `extractedFramesDir = temp_extracted/<jobId>` **and** called `deleteUploadFile`.
  This is the "delete everything after processing" remnant. **But its trigger was
  apply (`processVideo`), not upload/extraction-completion.**
- **`7bb7f8f` (Phase 4b-0: raw frames to disk)** narrowed the staging dir to
  `temp_extracted/<jobId>/_apply` and **removed** the `deleteUploadFile(videoPath)`
  from `finally` (diff confirmed: the `finally` now deletes only `_apply`).
- **`7ad2e77`** reverted 4b-0; **`b734e6d` (FIX V2)** re-landed it with the
  `_apply`-bounded clear + tripwire (the current state).

So in the deployed source there is **no surviving upload/extraction-completion
delete** of the persistent frames. The remnant the kickoff suspects was real, but
it is gone from the source under test. (If the *live binary* predates `7bb7f8f`,
the remnant could still be running there — that is candidate B in §4, and it is
testable.)

---

## 4. What is actually deleting the frames on the live server — ranked, with discriminating tests

Because no current-source line fits, the cause is environmental or deploy-state.
Ranked by fit to the evidence (whole-dir GONE, ~1s, every upload, **no pm2 log**):

**A. Out-of-process host sweeper (best fit for "no pm2 log").**
A host-level `cron`/`systemd-timer` running `npm run cleanup` /
`tsx scripts/cleanup-now.ts` (which calls the same `sweepDirectory`/
`cleanupJobArtifacts` with a possible `--max-age-ms=0`), **or** an OS
`tmpfiles.d`/container ephemeral-mount/EBS policy on the `temp_extracted` path.
A separate process explains the **total silence in the app log** and could fire on
a short interval (appearing "~1s after every upload" if it runs frequently).
- *Test:* `crontab -l`, `systemctl list-timers`, `ls -la /etc/cron.*`,
  `cat /etc/tmpfiles.d/* 2>/dev/null`, and `mount | grep temp_extracted` /
  `df temp_extracted` on the live host. Also `grep -r cleanup-now` in any deploy
  scripts and `pm2 ecosystem`/`pm2 startup` cron add-ons.

**B. Stale deployed binary (built from an older commit).**
The kickoff says "Confirmed on the live server (b734e6d)" — but that names the
*commit*, not the *running `dist/index.js`*. If the live `dist` was built before
`36f684e` (which removed the post-download `cleanupJobArtifacts` hook) or before
`7bb7f8f` (pre-4b-0 whole-dir apply delete), the deployed behavior diverges from
source. Note: the post-download hook fired on *download*, so it only fits if a
download/zip occurred; the pre-4b-0 apply-finally fits only if an apply ran.
- *Test:* on the live host, `git rev-parse --short HEAD`, `git status --porcelain`,
  rebuild (`npm run build`), and diff/checksum the `dist/index.js` against the
  artifact PM2 is actually running (`pm2 info masquerade` → script path).

**C. PM2 OOM restart → SIGTERM sweep (lower probability).**
`ecosystem.config.js` sets `max_memory_restart: '1G'`. A 164-frame extraction can
spike memory; if PM2 restarts, the `SIGTERM` handler runs
`sweepDirectory(TEMP_EXTRACTED_DIR, 0)` — deleting **all** temp_extracted. Fits
"every upload, ~1s after extraction." **But** it logs `Shutting down…` + `🧹`, and
PM2 records a restart, so it only fits "no log" if those lines were missed.
- *Test:* `pm2 info masquerade` restart count / uptime correlated with uploads;
  `pm2 logs` for `Shutting down`.

**D. CWD mismatch (unlikely).** `TEMP_EXTRACTED_DIR` resolves from
`process.cwd()`; ruled low because the COMPLETE log prints the *actual* absolute
dir the observer then watched.

---

## 5. Proposed fix — mandated instrumentation that is also the live diagnostic

The kickoff independently **requires**: "Add a log line to ANY delete that targets
`temp_extracted/`." This is the right move regardless of root cause, and it is the
*only* way to identify an in-process culprit (B/C) or **prove** it is out-of-process
(A): if the dir vanishes while the app log stays silent at that instant, the
deleter is provably external.

**Backend-only changes (no behavior change, no retention change, instrumentation only):**

1. **`safeDelete` (`cleanup.ts:100`)** — when the resolved target is inside (or is)
   `TEMP_EXTRACTED_DIR`, emit one loud line **before** `fs.rm`:
   `🗑️  [temp_extracted DELETE] <resolved path> — caller: <new optional label arg>`.
   Add an optional `label?: string` param (defaulted) so callers can name
   themselves; existing call sites compile unchanged (tsc stays 17). This makes
   **every** path that deletes anything under `temp_extracted` — including the
   `_apply` leaf and `cleanupJobArtifacts` — impossible to do silently again.
2. **`cleanupJobArtifacts` (`cleanup.ts:132`)** — pass `label: 'cleanupJobArtifacts'`
   and log the originating `jobId` so the whole-`<jobId>` delete is attributable to
   the `DELETE /api/jobs/:jobId` request (the only legit caller).
3. **`cleanupApplyStaging` (`applyPaths.ts:88`)** — pass
   `label: 'cleanupApplyStaging(_apply)'` so the leaf delete is visible and can be
   distinguished from a (illegitimate) parent delete at a glance.
4. **`sweepDirectory`** already logs `🧹`; add the per-entry resolved path when the
   swept root is `TEMP_EXTRACTED_DIR` so an age-based delete of a job dir is
   individually visible (today only the aggregate count prints).
5. **No change** to: retention windows, `SWEEP_TARGETS`, `b734e6d` re-entrancy fix,
   `_apply` isolation, the tripwire, or any read path. **No PHI behavior weakened** —
   frames that are deleted today are still deleted; they are merely *logged*.

**PHI note (per kickoff):** this proposal does **not** change whether or when any
PHI is deleted, so there is no PHI-posture decision to make and nothing to flag.
*If* approval includes actually **stopping** a delete once the culprit is found,
that is a separate, compliance-sensitive decision I will bring back rather than
decide here.

**Host-side actions for the human (not code):** run the candidate-A/B/C tests in
§4 on the live server. The instrumentation deploy + these checks together will
pin the cause definitively.

---

## 6. Test plan (GPU-free)

- **Unit (in `applyPaths.test.ts` / a small `cleanup` test):** call `safeDelete`
  on a seeded path under a tmp `temp_extracted` and assert the new
  `🗑️  [temp_extracted DELETE]` line is emitted (capture `console`), and that a
  delete *outside* `temp_extracted` does **not** emit it. Confirms instrumentation
  fires exactly on the target dir.
- **Regression:** existing 8 `applyPaths` tests stay green; the `_apply`-bounded
  delete still never touches the parent (unchanged behavior, now logged).
- **Live (human, post-deploy):** the kickoff §5 watch-loop. With instrumentation,
  the moment the dir goes `GONE`, `pm2 logs` either shows the new line (→ in-process
  culprit named with file:line + caller label) **or** shows nothing at that instant
  (→ out-of-process deleter proven; proceed to §4-A host checks).

---

## 7. Deliverables / next step

- This file = **deliverable 1**. **Stopping here for approval.**
- On approval I will implement §5 instrumentation + §6 tests and write
  `docs/refactor/PHASE_4B0_FRAMEDELETE_REPORT.md` (with the added delete-logging and
  test results), then hand the live diagnostic back to the human to run §4's tests.

**Decision requested:** approve the instrumentation-first approach (it cannot,
by construction, regress behavior and it is the kickoff's own requirement), with
the understanding that the *actual deleter* will be named by the first
instrumented upload on the live host — or proven external if the log stays silent.
