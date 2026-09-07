# Auto-mask — decisions on the sandbox report, item 5, and the Round 2A proposal

**Date:** 2026-09-04. **Inputs:** `AUTOMASK_SANDBOX_REPORT.md`, `ITEM5_RGB_DICOM_VERIFICATION.md`, `AUTOMASK_ROUND2A_PROPOSAL.md`. **Tree:** `main` @ `dc45954` + the uncommitted `reusePort` change.

---

## 1. Sequencing — three things change the order

**1a. Item 5 ships first, before any 2A code.** It is not an automask dependency; it is a shipped-path correctness bug: every colour-Doppler DICOM uploaded to prod since 2026-07-22 has shown a garbled frame on the canvas and would have been masked from that garbled frame. That outranks a feature behind a flag. Own commit, own revert, deployed on its own with the R1–R6 plan below.

**1b. Tune in Python before porting to TS.** The Track 0 bench exists, 29 proposals are built, and the depth control works in it. So the cheap loop is available *now*: Andre reviews the bench → Claude Code tunes the spike against those verdicts → constants freeze → *then* the TS port. Porting first and tuning after means porting twice (every constant change must be re-ported and re-fixtured). One Python tuning iteration on Track 0 verdicts is the entry condition for the 2A port.

**1c. The `reusePort` change and the PostHog guard ride along with item 5's deploy, as separate commits.** Both are prod-neutral one-liners; both are needed for the sandbox to be a clean instrument (the server must bind on macOS; sandbox sessions must not write events into the prod PostHog project during D5). Independent commits so each can be reverted alone; one deploy because none of them changes prod behaviour.

Order:
1. Item 5 fix + `reusePort` + PostHog hostname guard → sandbox verify → deploy (§2).
2. Andre: Track 0 review session on all 29 clips + the kickoff clips once added (§5).
3. Claude Code: one tuning pass on the spike against `reviews.json`; report what moved; freeze constants as `automask_spike/CONSTANTS.md`.
4. Round 2A per §3 (port the frozen algorithm).
5. D5 proper in the sandbox with `AUTOMASK=1`; then 2B.

---

## 2. Item 5 — approved, with these conditions

- Apply the diff in `ITEM5_RGB_DICOM_VERIFICATION.md` §4 exactly as scoped: `extractDicomFrame`, `tryRawDicomPixelData`, `processDicomPixelDataHelper` (new RGB branch; mono branch byte-for-byte untouched), `detectDicomFrameCount`. Nothing else in `frameExtractor.ts`.
- **`tsc` = 12 is a hard gate and this file holds 5 of the 12 parked errors.** Re-count after the edit; if the count moves in either direction, stop and report which line — no "fixing" parked narrowings incidentally, and no new ones.
- Verification = §5 R1–R5 in the sandbox, R1 (mono single + mono 67-frame byte-identical raw PNGs, `cmp` over `temp_extracted/`) is the one that guards the 2026-07-22 fix. R6 (real colour cine) stays open until Andre has one; the synthetic multiframe is acceptable evidence for the multiframe offset arithmetic because it was built with the same transfer syntax and layout.
- Add to the item 5 report: the `[PERF] apply.extract_frame` numbers for the RGB path (the interleave loop for `PlanarConfiguration 1` is O(n) JS per frame; on a 318-frame cine that is a number worth having, even if it is small).
- Report → deploy runbook from me → deploy. Snapshot first as always.

**PostHog guard (own commit):** in `client/src/lib/posthog.ts`, do not initialise when `location.hostname` is `localhost` / `127.0.0.1`, or when `VITE_POSTHOG_DISABLED=1`. No other change. Verify: sandbox session produces no network calls to PostHog; prod bundle unchanged in behaviour.

**`reusePort` (own commit, already written):** `process.platform === "linux"`. Commit as-is with the comment.

---

## 3. Round 2A proposal — approved with amendments

### 3.1 Open decision 1 (fixture in git): **yes.**
Commit one synthetic fixture: a rendered fan (known apex/radii/angles) plus a rectangle "header" and a few text-like thin lines on black, at 632×1080, with its expected `proposal.json`. The test runs it always; the 29 PHI fixtures run only when `AUTOMASK_FIXTURES_DIR` is set. Add a second synthetic: a trapezoid (poly path) with a `bound`.

### 3.2 Open decision 2 (worker vs inline): **inline, no `worker_threads`.**
Two reasons beyond the millisecond argument. (a) The server ships as a single esbuild bundle (`dist/index.js`); a worker needs its own entry point and build step, which is a `package.json`/build-config change with its own failure mode on the box — not worth it for a ≤ 50 ms job. (b) The work is bounded by construction: the grid is 4× downscaled (~158×270 on Butterfly, ~480×270 on 1080p), so there is no input that makes the JS run long. `sharp` decode is already off-thread. Gate: measure `ms_propose` on the reference clip at deploy (row A2); if it exceeds **100 ms** on the t3.large, revisit with a worker as its own item. Drop the 2 s timeout (meaningless inline); keep the try/catch → `none/error`.

### 3.3 Open decision 3 (item 5 before 2A): **yes** — §1a.

### 3.4 Amendments to the design
- **`Cache-Control: no-store` on every response**, not `private, max-age=3600` for ready. During tuning sessions the same job can be re-proposed after `automask.json` is deleted; an hour of browser caching on a 200-byte JSON buys nothing and will confuse the first sandbox session that hits it.
- **T0 availability is time-limited and the contract should say so.** The `(0018,6011)` box is read from the upload file, which is swept at 2 h and (for images) reclaimed after Apply. First request after that → `T1` with `bound: null`. Add `"bound_source": "dicom" | "unavailable"` to the JSON so the eval can tell "no tag" from "file was gone". Because the result is cached, the normal spoke flow (request on open) never sees this; only late `curl`s do.
- **Cache invalidation rule, stated:** `automask.json` is never regenerated by the server. To re-propose (after a tuning change), delete the file; the eval gets a `--fresh` flag that does exactly that for the jobs it scores.
- **`shared/automask/` must not enter the client bundle in 2A.** Nothing under `client/` imports it until 2B. Check the Vite chunk summary in the report (the 661 KB warning must read the same).
- **Fixture assertion on the far-field completion specifically.** Besides shape IoU ≥ 0.98, assert `|r_out_ts − r_out_py| ≤ 2 px` (fan) / `|y_bottom_ts − y_bottom_py| ≤ 2 px` (poly). The radial-profile walk is the one step where a port drifts by a bin and still passes an IoU test.
- **Eval joins on `filename` — make it robust.** Uploads may be renamed by multer; join on the original filename the job stores, and fall back to `(width, height, frames)` with a warning, not a silent drop.
- **Eval must run against Track 0 too.** `--bench ../sandbox/bench` scores `reviews.json` verdicts (depth-only references) with the same `score()` so the first D5 signal and the later sandbox sessions are on one scale.
- Row A2 gets a second number: `ms_propose` on the reference clip with the flag on, alongside `bg_extract.done` / `apply.done` unchanged.
- Add rows: **A14** `--prev` regression list is empty on an unchanged re-run and non-empty after a deliberate constant change (proves the regression detector); **A15** `npm run build` chunk summary unchanged.

### 3.5 Entry condition for 2A code (from §1b)
Track 0 review done; one Python tuning pass reported; `CONSTANTS.md` frozen. The port targets the frozen constants, and the fixture `proposal.json`s are regenerated from them before the TS work starts.

---

## 4. Sandbox report — follow-ups

| item | decision |
|---|---|
| ffmpeg ≥ 8 removes `-vsync` | Real prod time-bomb, low urgency (Ubuntu 24.04 LTS ships 6.1 and `apt upgrade` will not cross a major). Backlog with a note on `frameExtractor.ts:244,319,326`; ships after 2B when extraction is unfrozen, tested by swapping `ffmpeg@7` → `ffmpeg` in `up.sh`. |
| Hourly sweep in the sandbox | Live with it; sessions are shorter than 6 h. `CLEANUP_DISABLED` parked. |
| PostHog to prod project | Fixed in §2 (rides with item 5). |
| `Kidney.mp4`, `Normal Lung sliding 2.mp4` not on the Mac | Andre adds them under `sandbox/clips/butterfly/` (or wherever they came from), rows in `manifest.csv`, `bench.py` (only new clips compute). They are two of the seven D5 clips. |
| Manifest columns | Andre fills `depth_cm`, `furniture_touches_fan`, `probe`, `mode`. For the GE files: the header's ML6-15 is a linear probe in **virtual-convex** mode — record `probe=linear`, `mode=virtual_convex` so the poly-model results are diagnosable. |
| Corpus gaps | Only Butterfly + GE + one sector. Philips/Sonosite/Clarius folders are empty. Not blocking D5 (kickoff clips only), blocking the "ready to deploy 2B" gate (≥ 80 % across the corpus). Andre sources; a Lumify or Sonosite export with a scale bar against the fan edge is the single most valuable addition. |
| Track 0 finding — T2ext suggests > 2 px on 15/21 multi-frame positives | This is the 2C question. Andre's slider verdicts answer it: if his chosen depth tracks the T2ext suggestion (within ~10 px) on most of those 15, extend-only T2ext at `ready` is worth building as an *offer*; if not, drop it. The bench report should print `|user Δ − T2ext Δ|` per clip. |

---

## 5. Andre's Track 0 session (what to actually do)

```bash
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --serve   # http://localhost:8765
```
For each of the 29 (+2) clips, 30–60 s each:
1. Look at the outline on frame 1. Sides and top right? If not → **Wrong — needs redraw**, one line in notes on *what* is wrong (side merged with scale bar / apex off / top arc). Save.
2. Sides right but bottom short or long → drag the slider to where *you* would put the bottom of the cone (the image edge of the fan, not the last visible echo). → **Adjusted**. Save.
3. Right as-is → **Looks right**. Save.
4. Negatives: confirm "withheld"; if one proposes, note it.
Then `bench.py --report` and send me `sandbox/results/<date>_bench.md`. That file is the first D5 signal and the input to the tuning pass.

Judge as a user, not a grader: the question is "would I have clicked Accept (or Accept after one slide)?", not "is this the geometrically perfect cone."

---

## 6. Invariants
`tsc --noEmit` = 12 (item 5 touches the file that holds 5 of them — count before and after) · A3 frozen · masked 0-indexed / raw 1-indexed · `buildApplyMask`, apply loop, reuse guard untouched · extraction frozen **except** the item 5 lines · one commit per item, revert-safe · measure at production shape.

---

## Message for the Claude Code session

> Read `AUTOMASK_2A_DECISIONS.md`. Order changes: (1) **Item 5 ships first** — apply the §4 diff from `ITEM5_RGB_DICOM_VERIFICATION.md` exactly as scoped, verify R1–R5 in the sandbox (R1 byte-identical mono is the guard), re-count `tsc` (must stay 12 — this file holds 5 parked errors; report any movement), write `ITEM5_REPORT.md`. Two more commits in the same batch: the `reusePort` platform guard as written, and a PostHog no-init guard for localhost / `VITE_POSTHOG_DISABLED=1`. Stop for the deploy runbook. (2) After Andre's Track 0 review lands as `sandbox/results/<date>_bench.md` + `reviews.json`, do **one** tuning pass on the Python spike against it, report what moved and why (per-clip before/after, regression check), and freeze the constants in `scripts/automask_spike/CONSTANTS.md`. (3) Only then Round 2A, per your proposal with the amendments in §3: inline (no worker, no timeout), `no-store` everywhere, `bound_source` field, `--fresh` and `--bench` eval flags, far-field ±2 px fixture assertion, no client import of `shared/automask/`, rows A14–A15, synthetic fixtures in git. No 2B work. `tsc` 12 throughout.
