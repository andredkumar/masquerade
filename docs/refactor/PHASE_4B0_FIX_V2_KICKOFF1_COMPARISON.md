# Phase 4b-0 — FIX V2 vs `KICKOFF_1.md` Comparison Report

**Purpose.** Item-by-item audit of the already-implemented Phase 4b-0 FIX V2
against `PHASE_4B0_FIX_V2_FINAL_KICKOFF_1.md` (the version that adds the explicit
§5 Review Checklist, §6 re-deploy gating, §7 deploy hygiene, §8 post-mortem).
Per instruction, the kickoff takes precedence; where my delivery diverged I both
flag it and (for the one in-scope gap) close it.

**Bottom line.** Strong alignment. One actionable gap found and **fixed** in this
pass (the §149 literal-path log). One honest mechanism divergence surfaced (not a
fixable defect — see §2). §6/§7/§8 are manual follow-ups, not yet executed.

---

## 1. §5 Review Checklist — line by line

### The mechanism
| Kickoff item | Status | Evidence |
|---|---|---|
| Traces the literal run-2 directory operations | ✅ | Proposal §1a/§1b walk the run-2 mkdir → ffmpeg-write → readdir → cleanup order. |
| Identifies exactly which run-2 op **creates the nesting** | ⚠️ divergence | No such op exists in the current `_apply`-isolated source. The `<jobId>/<jobId>` nesting was the **pre-`_apply` variant** (`54487d3`), already replaced. See §2. |
| Identifies exactly which run-2 op **deletes the raw frames** | ⚠️ divergence | Same — whole-dir `safeDelete` in the old `finally` is gone; cleanup is now `_apply`-bounded. See §2. |
| Does **not** treat the AI `<jobId>/<runId>` layout as a doubling bug | ✅ | `aiRunDir` is labeled HYGIENE ONLY in code and docs; runId is a distinct UUID. |

### The fix
| Kickoff item | Status | Evidence |
|---|---|---|
| `_apply` starts CLEAN each run (clear-before-extract) | ✅ | `prepareCleanApplyStaging` calls `await cleanupApplyStaging(jobId)` then recreates empty (`applyPaths.ts`). |
| Never re-extracts into a dir whose pre-existing contents it reads back | ✅ | Clearing first guarantees the `readdir` readback contains only this run's frames. |
| Persistent `temp_extracted/<jobId>/frame_*.png` survive every re-apply | ✅ | Delete is `_apply`-bounded; repro test asserts all 164 persistent frames survive. |
| Cleanup is re-entrancy-safe (only `_apply`, never parent) | ✅ | `cleanupApplyStaging` asserts the `_apply` leaf + `safeDelete` bounded to `rawFramesDir`. |
| `deleteUploadFile` removal kept (upload preserved for re-apply) | ✅ | Removal + `_apply`-only `finally` cleanup left intact. |

### The repro test
| Kickoff item | Status | Evidence |
|---|---|---|
| Leaves run-1 RESIDUE present before run 2 | ✅ | Test seeds 200 stale frames in `_apply` + 164 persistent in parent before run 2. |
| Asserts readback is run-2 frames only (not stale) | ✅ | `assert.equal(created.length, 164, …)`. |
| **Fails before** the fix (RED) and **passes after** (GREEN), both shown | ✅ | Report §3a RED (`got 200 … 200 !== 164`), §3b GREEN (6 pass). |
| Pure function / no GPU / no mock | ✅ | Drives real FS under a tmp cwd; `node:test` + `tsx`. |

### Hygiene / scope
| Kickoff item | Status | Evidence |
|---|---|---|
| Tripwire at each mkdir site: **log the literal resolved path** AND assert no equal-adjacent-segment nesting (§149) | ✅ **(fixed this pass)** | Was PARTIAL — assertion present, log absent. Now logs `path.resolve(...)` at all three sites. See §3. |
| `applyPaths.ts` retained and extended | ✅ | Kept; extended with the prep helper + tripwire + `aiRunDir`. |
| No `global.extractedFrames` reintroduced | ✅ | Untouched. |
| No retention / `SWEEP_TARGETS` change | ✅ | Untouched. |
| No read-path (5a–5c) regression | ✅ | No read path modified. |
| tsc held at exactly 17 | ✅ | 10 `frameExtractor.ts` + 7 `maskWorker.ts`, unchanged. |
| Backend-only | ✅ | No client changes. |

### Red flags (kickoff rejection triggers)
None triggered: AI not treated as a bug; residue present in repro; RED shown; no
"build mismatch" theory; mechanism is the temporal run-1→run-2 stale-readback (not
static "can't double" analysis).

---

## 2. The one honest divergence (not a fixable defect)

§5 presupposes a run-2 operation that *creates the `<jobId>/<jobId>` nesting* and
*deletes the persistent raw frames*. **In the current re-landed source, no such
operation exists.**

- Those two symptoms belonged to the **pre-`_apply` variant** (`54487d3`):
  whole-dir `extractedFramesDir = temp_extracted/<jobId>` + a whole-dir
  `safeDelete` in `finally`. That variant was already replaced by the
  `_apply`-isolated layout before this work began.
- The **only remaining in-code defect** is **stale-readback count inflation**, and
  it only triggers when **run 1 is interrupted** (SIGTERM / OOM / throw-in-catch)
  *before* its `finally` cleanup completes, leaving residue in `_apply`. A clean
  redo loop already self-clears via the gated `finally`.

This is why the repro test must seed residue: a test that cleans state between
runs proves nothing. The divergence is documented in proposal §1c and §100-115;
it is surfaced here rather than papered over to make the checklist read green.

The fix is still worth landing: it makes `_apply` clean **unconditionally** (not
contingent on a `finally` a killed process can skip) and the tripwire catches the
nesting class loudly if it ever regresses.

---

## 3. Gap closed this pass — §149 literal-path logging

§149 requires each mkdir site to **both** assert no equal-adjacent-segment nesting
**and** log the literal resolved path. The assertion was present at all three
sites; the log was missing. Added a resolved-path log at each:

| Site | File |
|---|---|
| `_apply` staging mkdir | `applyPaths.ts` (`prepareCleanApplyStaging`) |
| raw-frame mkdir | `videoProcessor.ts:1129` (`startBackgroundFrameExtraction`) |
| AI run-dir mkdir | `routes.ts:943` (AI handler) |

Each logs `\`🗂️  […] mkdir ${path.resolve(<dir>)}\``. `path` is already imported at
module scope in all three files; no new imports.

**Verification after the change**
- Repro test: **6/6 GREEN** — the new `🗂️  [apply-staging] mkdir …` line is
  visible in the run-2 residue test output.
- `npx tsc --noEmit`: **exactly 17** pre-existing errors (10 `frameExtractor.ts` +
  7 `maskWorker.ts`); the logging added zero type errors.

`PHASE_4B0_FIX_V2_FINAL_REPORT.md` §1 (change table) and §5 (scope check) were
updated to record the logging.

---

## 4. Follow-ups — executed this pass (per reviewer's two additions)

The reviewer reclassified §6 from a deferrable follow-up to the **required**
verification step (the live redo loop is the only check against what was actually
deployed, since current source can't reproduce the original symptoms). All three
are now done as part of the fix:

- **§6 re-deploy gating — DONE.** `deployment-package/README-AWS-DEPLOYMENT.md` now
  has a "Post-deploy verification — REQUIRED" section: upload once, apply (redo
  loop run #1), then re-mask + apply again for the SAME jobId (run #2) on the live
  server, confirm both complete, grep `pm2 logs` for the `🗂️` tripwire mkdir lines
  with no doubled segment, and confirm persistent frames survived both applies.
- **§7 deploy hygiene — DONE.** Same runbook gained a Step 0 pre-flight before any
  build: record `git rev-parse --short HEAD` and require `git status --porcelain`
  to be empty (clean tree) before `npm run build` + PM2.
- **§8 post-mortem — DONE.** `CLAUDE.md` gained a dated "Phase 4b-0 FIX V2 —
  `processVideo` re-entrancy post-mortem (2026-06-17)" section: the re-entrancy
  lesson, the clear-before-extract fix, the tripwire (assert + literal-path log),
  and the honest scope caveat that makes the live redo loop the required gate.

## 4b. Tripwire self-test — added this pass (reviewer addition 2)

The repro test proves the stale-readback fix but does **not** exercise the nesting
symptom. The tripwire is the safety net for that class, so it is now proven to
fire with its own red-green pair in `applyPaths.test.ts`:

- `tripwire … THROWS on synthetic <jobId>/<jobId> nesting` — feeds
  `assertNoSegmentDoubling` a synthetic `temp_extracted/<jobId>/<jobId>/_apply`
  path and asserts it throws `/path-doubling tripwire/`.
- `tripwire … PASSES a correct non-doubled path` — feeds the well-formed
  `temp_extracted/<jobId>/_apply` and asserts it does not throw.

**Red-green proof:** with the assertion temporarily neutered (early `return`), the
THROWS case fails (`Missing expected exception`) → **7 pass / 1 fail (RED)**; with
the assertion restored → **8 pass / 0 fail (GREEN)**. The test suite is now 8
tests (6 original + 2 tripwire).

## 4c. Commit / deploy

- Committed cleanly; working tree `git status` clean after commit.
- **No deploy performed** — Andre deploys via the runbook.

---

## 5. Files touched in this comparison pass

| File | Change |
|---|---|
| `server/services/applyPaths.ts` | + resolved-path log in `prepareCleanApplyStaging`. |
| `server/services/videoProcessor.ts` | + resolved-path log at raw-frame mkdir. |
| `server/routes.ts` | + resolved-path log at AI run-dir mkdir. |
| `docs/refactor/PHASE_4B0_FIX_V2_FINAL_REPORT.md` | §1 table + §5 scope check updated for §149 logging. |
| `docs/refactor/PHASE_4B0_FIX_V2_KICKOFF1_COMPARISON.md` | This report (new). |

No change to `frameExtractor.ts`, `cleanup.ts`, `frameAccess.ts`, retention,
`SWEEP_TARGETS`, read paths, or any test logic (the repro test is unchanged and
still passes).
