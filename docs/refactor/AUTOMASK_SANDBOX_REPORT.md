# Auto-mask sandbox — setup report

**Date:** 2026-09-04. **Design:** `AUTOMASK_SANDBOX_DESIGN.md` (copied into this folder). **Recon:** `AUTOMASK_SANDBOX_RECON.md`. **Tree:** `main` @ `dc45954` + the one app change in §3.
**Outcome:** the sandbox runs. Every gate in the recon's verification plan passed on this Mac; the Track 0 bench is built for all 29 local clips and serves review pages with the depth control.

---

## 1. What exists now

| piece | where | state |
|---|---|---|
| Corpus + manifest | `~/Desktop/Masquerade/sandbox/clips/**`, `sandbox/manifest.csv` (29 rows, 1.1 GB) | 5 Butterfly MP4s, 18 GE LOGIQ E9 DICOMs (10 single-frame incl. 2 colour-Doppler, 8 multiframe 67–318 f), 1 sector `.mov`, 2 Butterfly stills, 3 negatives. `depth_cm`, `furniture_touches_fan`, some `probe`/`mode` cells are for Andre to fill. Empty vendor folders (philips, sonosite, clarius, mindray) are waiting for clips. |
| Postgres 16 | `sandbox/db/pg16`, port 5433, user `masq`, trust auth, log `sandbox/db/postgres.log` | migrated (`jobs`, `ai_runs`, `frame_processing_batches`) |
| Env | `sandbox/.env.sandbox` | `DATABASE_URL=postgresql://masq@localhost:5433/masq`, `PORT=5001`, `ALLOWED_ORIGINS=http://localhost:5001`, `AUTOMASK=1`, GPU URLs → `127.0.0.1:9` |
| Scripts | `scripts/sandbox/{common,up,down,reset,status}.sh` | `up.sh` = cluster → createdb → migrate → binaries check → `npm run dev` with stdout tee'd to `sandbox/results/server_<ts>.log`; `--db-only`; `reset.sh [--yes]`; `status.sh` |
| Track 0 bench | `scripts/automask_spike/bench.py` + `bench_static/{shape.js,review.js,style.css}`; output `sandbox/bench/` | 29 proposals built; `--serve` on :8765; `--report` writes `sandbox/results/<date>_bench.md` |
| Docs | `sandbox/README.md`, this file, the recon | |
| Gitignore | `.gitignore` +`sandbox/`; `scripts/automask_spike/.gitignore` (`out/`, `__pycache__/`) | nothing PHI-bearing is trackable |

Installed on the Mac this session (Homebrew): `postgresql@16` 16.15, `ffmpeg` 9.0.1 (turned out unusable, see §2), `ffmpeg@7` 7.1.5.

## 2. Two things the design could not have known (both in the recon §0 table)

1. **ffmpeg 9 breaks the app.** `extractAllFramesSinglePass` passes `-vsync 0` (`frameExtractor.ts:319`), removed in ffmpeg ≥ 8. The first MP4 upload failed in 72 ms (`bg_extract.done {frames:0, outcome:'failed'}`, "Unrecognized option 'vsync'"). Extraction code is off-limits, so `up.sh` puts the keg-only `ffmpeg@7` first on `PATH` and warns when the resolved ffmpeg is ≥ 8. **This will bite prod when Ubuntu ships ffmpeg 8** — backlog item, one-line `-fps_mode passthrough` fix with its own revert.
2. **`reusePort: true` cannot bind on macOS with Node 25** (`ENOTSUP` from a bare `http.createServer` on any port); port 5000 is also macOS AirPlay Receiver's. See §3.

## 3. The one app change (own commit, prod-neutral)

`server/index.ts:171`: `reusePort: true` → `reusePort: process.platform === "linux"`, with a comment pointing here. Linux (prod) behaviour is byte-identical; macOS can now listen. `npx tsc --noEmit` = **12** (unchanged). Nothing else under `server/`, `client/`, `shared/` was touched. Deploy = revert-safe.

## 4. Gate results (recon §10)

| # | step | result |
|---|---|---|
| S1 | `up.sh --db-only` on a fresh `sandbox/db` | ✅ after adding `LC_ALL=en_US.UTF-8` (Homebrew postgres dies with "postmaster became multithreaded" without it). `drizzle-kit migrate` applied `0000_hard_cable.sql`; `status.sh` → 0 jobs. |
| S2 | `up.sh` boot log | ✅ `app DATABASE_URL target → localhost:5433/masq user=masq` · `database reachable … public.jobs=true` · `serving on port 5001` · `FFmpeg: INSTALLED (7.1.5)` · `Video processing: READY` |
| S3 | MP4 upload (`bfly_z2b.mp4`, 632×1080) → spoke | ✅ `bg_extract.first_frame_on_disk` **105 ms**; `bg_extract.done` 386 ms, 295 frames vs 293 estimated → `parity:false, corrected:true` (the reconcile fires locally too); `GET /frames/0` → 200 `image/png`; canvas painted in the real UI. |
| S4 | draw (rectangle over the header, real Fabric canvas via the in-app browser) → **Apply Mask to All** → download | ✅ `apply.source {mode:'reuse', frames:295}` · `apply.mask_build 25.2 ms, masked_px 25829/682560 (3.8 %)` · `apply.done 767 ms` (M4 Pro; prod is 8.7 s) · 295 masked frames `frame_000000.jpg…` (0-indexed) · `jobs.mask_data` present (`rectangle`, 23 KB `canvasDataUrl`) · ZIP 17.0 MB, 298 entries, `manifest.json` `total_frames: 295`, `metadata.csv`; frame 0 opened — header blanked, cone intact. |
| S5 | DICOM multiframe (`ge_e9_4351124429.dcm`, 67 f) → apply (canvas-shaped `maskData` over the header bar, via the API) → download | ✅ `first_frame_on_disk` 346 ms (`dicom-batch`), `bg_extract.done` 1.38 s, 67/67 `parity:true`; `apply.source reuse 67`; `apply.done` 208 ms; ZIP 3.9 MB, 70 entries; frame 0 opened — header bar blanked. |
| S6 | `AUTOMASK` unset | ✅ trivially identical — no automask code exists in the tree yet; S3/S4 *are* the baseline. Re-run this row after Round 2A lands. |
| S7 | `reset.sh --yes` | ✅ tables truncated, `uploads/ temp_extracted/ temp_processed/ spokes/*` emptied, clips/manifest/bench/results untouched, `status.sh` → 0 jobs. |

**Bench smoke (Track 0):** `bench.py` built proposals for all 29 clips (0.0–2.0 s extraction each; DICOM via pydicom). `--serve` served `index.html` and a review page; on `bfly_z2b` the slider moved `r_out` 1144 → 1204 (label showed "Δ +60 px · T2ext suggests 1200 (Δ +56)"), the layer re-rendered, Save POSTed to `reviews.json` (then cleared so Andre starts clean). On a GE trapezoid (`ge_e9_4351124429`) the poly depth control extended `y_bottom` 668 → 736 along the fitted side lines, clipped by the region box. **Correction, later the same day:** that smoke only proved the label changed — the polygon itself did not move (`polyPoints` compared the requested bottom against the shape's *own* edited bottom, so it always returned the fitted polygon), and the tint inside the keep-region cleared to 55 % instead of 0 (destination-out drawn with a translucent colour). Both fixed in `bench_static/shape.js` / `bench.py` (`y_bottom_fit`, opaque punch-out) and re-verified by reading canvas pixels: inside alpha 0, outside 115, polygon bottom follows the slider. Negatives were withheld (`masks_too_little` ×2, `interior_not_ultrasound` ×1).

Track 0 headline on the local corpus (before any review): 26/26 positive clips produced a proposal (conf 0.75–0.95); T2ext would extend depth by > 2 px on 15 of the 21 multi-frame positives (+4 to +80 px), which is exactly the far-field question Andre's verdicts will settle.

## 5. How to use it (Andre)

```bash
masquerade-aws-latest/scripts/sandbox/up.sh            # Postgres + migrations + server on http://localhost:5001
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --serve   # Track 0 at http://localhost:8765
python3 masquerade-aws-latest/scripts/automask_spike/bench.py --report  # table → sandbox/results/<date>_bench.md
masquerade-aws-latest/scripts/sandbox/reset.sh          # wipe jobs + working dirs; keeps clips/bench/results
masquerade-aws-latest/scripts/sandbox/down.sh           # stop Postgres
```
Add clips under `sandbox/clips/<vendor>/`, add a row to `manifest.csv`, run `bench.py` again (only new clips are computed; `--rebuild` recomputes all). The bench frame cache is `sandbox/bench/_frames/` (PHI).

Known behaviour to expect (recon §6): each server boot wipes `uploads/`; the hourly sweep still runs (2 h uploads / 6 h raw frames / 24 h masked output). PostHog events still go to the prod project (recon §4).

## 6. Not done / deferred, with reasons
- `Kidney.mp4` first-run gate — clip not on this Mac; S3–S4 used `bfly_z2b.mp4`. Re-run when added (a `curl -F video=@…` to `/api/uploads/video` reproduces S3 without the UI).
- `CLEANUP_DISABLED` knob and a PostHog off-switch — app code, each its own item; not needed for correctness.
- `docker-compose.yml` — not written; Homebrew Postgres chosen because Docker is absent. If Docker arrives, the same `.env.sandbox` works with a container on 5433.
- After the gates the hand-started dev server and bench server were stopped and `reset.sh --yes` was run again, so the sandbox is clean (0 jobs). Postgres was left running on 5433 (`down.sh` stops it; `up.sh` restarts everything).

## 7. Backlog opened
1. **ffmpeg ≥ 8 removes `-vsync`** — `frameExtractor.ts:244,319,326` → `-fps_mode passthrough`. Not urgent until the prod box upgrades; test on the sandbox first (swap `ffmpeg@7` for `ffmpeg` in `up.sh`).
2. `CLEANUP_DISABLED=1` (default off) in `cleanup.ts` for long sandbox sessions.
3. `VITE_POSTHOG_DISABLED` or a hostname guard in `client/src/lib/posthog.ts` so localhost never reports.
4. Manifest columns Andre must fill before results are diagnosable: `depth_cm`, `furniture_touches_fan`, `probe` for the GE files (header says ML6-15 = linear; the images are virtual-convex trapezoids).
5. **Backlog item 5 is a live bug and wider than described** — colour-Doppler (RGB) DICOMs extract garbled on the canvas/apply path, single-frame included; found with the sandbox on the two real colour-Doppler stills. Evidence, root cause and the unapplied fix diff: `ITEM5_RGB_DICOM_VERIFICATION.md`.
6. `.gitignore` had to be `/sandbox/` (root-anchored): the unanchored form also ignored `scripts/sandbox/`.
