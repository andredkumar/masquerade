# Auto-mask sandbox — design

**Purpose:** a place on Andre's Mac where the cone proposer can be tried on real clips, corrected by hand, scored against those corrections, tuned, and tried again — in minutes per iteration, with no deploy and no PHI leaving the machine. It is the D5 gate, the tuning loop for every later automask round, and the seed of the template library.

**What it is not:** a perf environment. Milliseconds still get measured on the t3.large (one physical core). The sandbox answers *is the proposal right and does the interaction work*; prod answers *is it cheap enough*.

**Why not a staging box on AWS:** every iteration would be commit → push → pull → build → restart (~5 min) instead of save → reload (~5 s); a second EC2 costs money to sit idle; and the clips carry burned-in PHI, which is simplest to keep on a device Andre already controls. A staging instance is worth it later for perf-shaped tests of the whole pipeline, not for this.

---

## 0. Two tracks, so prototyping starts before Round 2A code exists

| | Track 0 — spike bench | Track 1 — local Masquerade |
|---|---|---|
| What | The existing Python spike plus a tiny local review page per clip: frame 1, the proposal outline, a **depth slider** that re-renders the parametric shape in the browser, buttons *Looks right / Adjusted / Wrong — needs redraw*. Writes `bench/reviews.json`. | The real app running on the Mac against a local Postgres, `AUTOMASK=1`, plus the `automask_eval` script from 2A. |
| Available | Days (Claude Code, one item). No app code touched. | After 2A (proposer + endpoint + eval) lands. 2B adds the in-app depth control. |
| What Andre can do | Feel the proposer and the depth control on his own clips; produce **depth-only references** and a verdict per clip; flag the clips that need a real redraw. | Everything: upload, see the proposal, correct it by drawing, Apply, review masked frames, download. Every correction becomes a reference automatically. |
| What it produces | `bench/reviews.json` → adjusted `r_out` per clip + verdict. Enough to run D5 on the kickoff clips *before* 2A. | `jobs.mask_data` per job → the eval script scores every proposal against the mask Andre actually applied. |
| Limits | No freehand correction; no real UX; Python, not the TS core. | Needs the local run to work (recon §2). Until 2B, corrections are freehand only (no depth slider in-app). |

Track 0 is a prototype of the *interaction*, not of the product. The parametric re-render it needs in JS (fan: apex, `r_in`, `r_out`, `th_l`, `th_r`; poly: side lines + bottom) is the same function the 2B canvas layer needs, so it is written once and carried forward, not thrown away with the rest of the spike.

---

## 1. Layout on disk (all gitignored; `sandbox/` lives beside the repo, not inside it)

```
~/Desktop/Masquerade/
  masquerade-aws-latest/          # the repo
  sandbox/
    clips/                        # the corpus (§3). Never synced, never committed.
      butterfly/  ge_logiq/  philips/  sonosite/  clarius/  mindray/  stills/  negative/
    manifest.csv                  # one row per clip (§3.2)
    bench/                        # Track 0 output: <clip>/review.html, reviews.json
    results/                      # eval tables, one file per session: 2026-09-07_run1.md
    db/                           # Postgres data volume (docker) — or empty if using Postgres.app
    .env.sandbox                  # local env (§2.2)
```

`clips/` and `db/` hold PHI. Keep them inside FileVault-encrypted storage (default on the Mac), never in iCloud Drive / Dropbox / a synced Desktop, and check the folder against Stanford's policy for identifiable data on local devices before filling it. The sandbox should be as boring as a shared drive full of DICOMs — but it is one, so treat it that way.

---

## 2. Track 1 setup (Claude Code recon first, then a one-time script)

### 2.1 Recon (answer with `file:line` before writing the setup script)
1. **DB.** What does the server do at boot with `DATABASE_URL` — the boot probe reports the RDS target and `jobs` table; does it FATAL on a local URL, on missing SSL, on `sslmode=no-verify` absent? Does `resolveSsl` handle `localhost` without SSL? How are migrations applied — `drizzle-kit push`, `migrate`, or by hand against RDS? Is there a `drizzle.config.ts` env path that is not `DATABASE_URL`?
2. **Serving.** Does `npm run dev` run the Vite dev server and the Express server together (one port, or 5173 + 5000 with a proxy)? Does the frames endpoint, the Socket.IO progress channel, and the download route work under that split? What does the Socket.IO CORS (7A) do when `ALLOWED_ORIGINS` is unset — reject `localhost:5173`?
3. **Binaries.** Where does the server look for ffmpeg/ffprobe (`PATH`, env var, `ffmpeg-static`)? Does DICOM extraction need anything beyond `dcmjs` (no external `dcmtk`)?
4. **Third parties.** PostHog: does the client crash or just no-op without a key? Anything else that reaches out (S3, SES, the GPU box for the AI spoke — that one is *expected* to be unreachable and must not break the template spoke)?
5. **Directories.** `uploads/`, `temp_extracted/`, `temp_processed/`, `spokes/` — created at boot (`ensured` in the boot log) or expected to exist? Any absolute paths?
6. **Cleanup scheduler.** The six sweep targets — do they run in dev and would they delete sandbox jobs mid-session? A `DISABLE_CLEANUP=1` (or long intervals) for the sandbox, if not already possible.

### 2.2 What the setup should end up as
- `docker compose -f sandbox/docker-compose.yml up -d` → Postgres 16 on `localhost:5433` (not 5432, to avoid colliding with anything installed), data in `sandbox/db/`. (Alternative if Docker is unwelcome: Postgres.app. Either is fine; pick one and document it.)
- `sandbox/.env.sandbox`: `DATABASE_URL=postgres://masq:masq@localhost:5433/masq?sslmode=disable` (or whatever `resolveSsl` needs), `AUTOMASK=1`, `ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5000`, `PORT=5000`, PostHog key unset, cleanup disabled or intervals long, any GPU-box URL pointed at nothing.
- `scripts/sandbox/up.sh`: start Postgres, apply migrations to it, `npm run dev` with the sandbox env. `scripts/sandbox/reset.sh`: truncate the job tables, empty `uploads/ temp_extracted/ temp_processed/ spokes/`. `scripts/sandbox/down.sh`.
- First-run gate: upload `Kidney.mp4`, draw, Apply, download, open the ZIP. That is the sandbox's own T1–T5.

**Invariants:** nothing in the setup touches prod config, `deploy.sh`, `.env` on the server, or A3. New files only under `scripts/sandbox/` and `sandbox/`; one `.gitignore` line for `sandbox/`.

---

## 3. The corpus

### 3.1 Coverage — what to collect, roughly 30 clips
The proposer is deterministic; the corpus is what makes its parameters honest. The spike set was 4 Butterfly lung clips, 1 sector, 4 GE LOGIQ E9 and 3 negatives — narrow. Fill in:

| Axis | Need | Why |
|---|---|---|
| Vendor | Butterfly iQ/iQ3, GE (LOGIQ, Venue), Philips (Lumify, EPIQ/Affiniti export), Sonosite, Clarius, Mindray if any | Different furniture positions, scale bars, header bars; virtual-convex vs true sector |
| Probe geometry | phased (cardiac/lung), curvilinear (abdomen), linear (vascular/MSK) — each from ≥ 2 vendors | Fan / annular-sector / rectangle models all get exercised |
| Mode | B-mode; colour Doppler (box inside the cone, panel outside); M-mode and PW Doppler (dual region — should be *withheld or partial*, must not leak the trace); dual-screen | The dynamic-non-cone cases and the two-region cases |
| Depth | same preset at shallow and deep settings; a clip with a depth change mid-clip | Far-field completion; the changing-cone case |
| Content | echo-free far field (dim bottom third), acoustic shadow, near-field artefact, mostly-black (pleural effusion), very bright (bone) | Where density thresholds fail |
| Format | MP4 (Butterfly export, cart export), DICOM single/multiframe mono, DICOM RGB single **and multiframe** (backlog item 5), PNG/JPG stills, screen recording, phone video of a screen | Every intake path |
| Furniture touching the fan | a cart clip where the depth scale or focus markers abut the fan edge | The T2-deciding case that never made it into the spike |
| Negatives | stock video, a photo, a slide, a non-ultrasound medical image (CXR) | Must withhold |

Butterfly Cloud export via the existing `butterfly-clip-export` workflow is the fastest source for the Butterfly rows; the rest come from whatever cart exports and archived DICOMs are already on hand.

### 3.2 `manifest.csv` — one row per clip, filled by Andre once
`clip_id, path, vendor, device, probe, mode, format, frames, w, h, depth_cm, furniture_touches_fan(y/n), phi_location(header/footer/side/in_cone/none), expected(propose/withhold), notes`

The manifest is what turns a results table into a diagnosis ("all three failures are Philips linear at 4 cm") instead of a count.

---

## 4. A session

1. `up.sh`. Confirm the boot log shows the local DB and no RDS.
2. Upload a batch (5–10 clips). For each: open the template spoke, look at the proposal, then **do what a real user would do** — Accept, adjust depth (2B) or draw over it, or Dismiss and draw. Apply. Glance at masked frames (item 20 review surface if landed; else the ZIP).
3. `npx tsx scripts/automask_eval/run.ts --manifest ../sandbox/manifest.csv --out ../sandbox/results/<date>_runN.md`.
4. Read the table: per clip — tier, model, confidence, IoU / leak / over-blank / `_core6` vs the applied mask, depth delta, outcome (Accept / Edit / Dismiss from the telemetry line), and the manifest columns. Bottom: counts under the tolerant rule, worst leak, worst over-blank, and **regressions vs the previous session** (same clip, worse number).
5. Claude Code tunes against the *whole* accumulated set (spike re-run is seconds), ports to the TS core, fixture test, `reset.sh` if the change alters proposals, repeat.

Rules for the loop:
- **The corpus only grows.** A tuning change is accepted only if it does not regress any earlier clip past the tolerant rule. Prevents fitting the latest failure at the cost of the last five.
- **Andre's applied mask is the reference, always** — even when it is sloppy. The eval's `_core6` band absorbs boundary sloppiness; a clip where Andre's own mask was wrong gets re-drawn, not excluded.
- **Withheld is a result, not a miss.** Negatives that withhold score as pass; a positive that withholds scores as a miss with `withheld` as the reason and its components logged.
- **Every session file is kept.** `results/` is the paper trail for the eventual "how do you know it works" question.

---

## 5. What the eval script must do (2A deliverable, shipped)

Input: local DB (`jobs`: `mask_data`, `job_type`, `file_list`, dims), `temp_extracted/<jobId>/automask.json`, the `[PERF] automask.*` lines (from the dev server's stdout captured to a file, or re-read from `automask.json` where the worker also stores the outcome), and `manifest.csv` joined on original filename.
Per job: decode `mask_data.canvasDataUrl` → reference mask at frame size; render the proposal `keep` (with `margin_px`) → proposal mask; compute IoU, leak, over-blank, `leak_core6`, `over_core6`; read tier/model/conf/ms; compute depth delta if the outcome line has a user `r_out`.
Output: Markdown table + a JSON with the same rows; summary block; regression list vs the previous results file. One command, no arguments beyond paths. Reuse the spike's scoring code semantics exactly so Track 0 and Track 1 numbers are comparable.

---

## 6. Exit criteria

| Gate | Criterion |
|---|---|
| Sandbox works | `Kidney.mp4` upload → draw → Apply → ZIP opens, on the local DB, with `AUTOMASK` unset behaving as prod does today. |
| D5 (unchanged) | ≥ 5/7 kickoff clips meet the tolerant rule (IoU ≥ 0.90, `leak_core6` ≤ 1 %) with the *fitted* `r_out`. Report the count *after* depth adjustment separately. |
| Ready to build 2B | D5 passed; the Track 0 bench shows the depth control resolves the far-field cases without touching the sides. |
| Ready to deploy 2B | Across the full corpus: ≥ 80 % of positive clips are Accept or depth-only; **no** positive clip has `leak_core6` > 1 %; all negatives withhold; no regression vs the previous session; then the prod perf check from the proposal §6. |

---

## 7. Who does what

| Andre | Claude Code |
|---|---|
| Collect the corpus, fill `manifest.csv`, decide the storage location | Track 0 bench (one item, days) |
| Run sessions; correct like a user, not like a grader | Recon §2.1; `scripts/sandbox/*`; `.env.sandbox` template |
| Supply the colour-Doppler cine for backlog item 5 | 2A: TS core, worker, endpoint, fixture test, `automask_eval` |
| Read the results table; call regressions | Tune against the accumulated set; report what changed and why, per session |

## 8. Order of work
1. Track 0 bench + §2.1 recon (parallel, both Claude Code).
2. Andre: corpus + manifest; run Track 0 on the seven kickoff clips → early D5 signal.
3. Sandbox setup scripts; first-run gate.
4. Backlog item 5 verified with the RGB cine (own item, own revert).
5. Round 2A → deploy flag-off → sandbox with `AUTOMASK=1` → D5 proper.
6. Round 2B → sandbox sessions until the "ready to deploy" gate → prod.
