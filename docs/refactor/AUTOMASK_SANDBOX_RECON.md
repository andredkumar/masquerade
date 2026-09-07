# Auto-mask sandbox — recon (local run of Masquerade on the Mac)

**Date:** 2026-09-04. **Answers:** `AUTOMASK_SANDBOX_DESIGN.md` §2.1 (items 1–6) and `AUTOMASK_ROUND1_AMENDMENT.md` §4 (items 1–3). **Tree:** `main` @ `dc45954`, working copy.
**For:** the agent (or Andre) setting up or debugging the sandbox. Every claim is a `file:line` in this checkout or a command that was run here.

---

## 0. Corrections to the design's premises (read first)

| Design assumed | Actually | Consequence |
|---|---|---|
| Vite on 5173 + Express on 5000 with a proxy | **One port.** `npm run dev` = `NODE_ENV=development tsx server/index.ts` (`package.json` scripts). Vite runs as Express *middleware* with HMR on the same HTTP server — `server/vite.ts:22-40` (`middlewareMode: true, hmr: { server }`), wired at `server/index.ts:158-162`. | Only origin is `http://localhost:5000`; no CORS split; frames/socket/download all same-origin. |
| `docker compose … Postgres 16 on 5433` | **No Docker on this Mac** (`which docker` → none; no Docker.app). Homebrew is present. | Chosen: Homebrew `postgresql@16` (keg-only, `/opt/homebrew/opt/postgresql@16/bin`), cluster in `sandbox/db/pg16`, port 5433. Installed this session: `postgresql@16` 16.15, `ffmpeg` 9.0.1 (`brew install postgresql@16 ffmpeg`). |
| "PostHog: does the client crash or no-op without a key?" | Neither — the key is **hardcoded**: `client/src/lib/posthog.ts:5` (`posthog.init('phc_…', { api_host: 'https://us.i.posthog.com' })`), called from `client/src/App.tsx:61`. Events: `mask_processing_started` (`ProcessingControls.tsx:133`), `frames_downloaded` (`ProcessingStatus.tsx:125`). No `import.meta.env` anywhere in `client/src`. | Sandbox sessions post those two events to the prod PostHog project. Payload is metadata (mask type, counts), no pixels. Not blocking; documented in `sandbox/README.md`. A `VITE_POSTHOG_DISABLED` switch would be app code — not this item. |
| `DISABLE_CLEANUP=1` "if not already possible" | **Not possible today.** `server/services/cleanup.ts` reads no env var (grep `process.env` → 0 hits). Boot purges `uploads/` (`:282-312`) and `temp_processed/` (`:328-358`); hourly cron `0 * * * *` sweeps the six targets (`:390-408`) with 2 h / 6 h / 24 h windows (`:54-71`). | Live with it: a session is a 2-hour window for image batches and 6 hours for raw frames; restarting the server kills image jobs. Adding a knob is a one-line app change with its own revert — proposed as a follow-up, not done here. |
| "Is ffmpeg on the Mac path for the server?" | It was not; and the *current* Homebrew `ffmpeg` (9.0.1) **does not work with the app**: `extractAllFramesSinglePass` passes `-vsync 0` (`frameExtractor.ts:319`, retry `:326`; also `extractAllFramesSequential` `:244`), an option removed in ffmpeg 8. First sandbox upload failed in 72 ms: `Unrecognized option 'vsync'` → `bg_extract.done {frames:0, outcome:'failed'}`. Prod's Ubuntu ffmpeg (≤ 7) accepts it; extraction code is off-limits. | `brew install ffmpeg@7` (keg-only); `up.sh` prepends `/opt/homebrew/opt/ffmpeg@7/bin` to `PATH` and warns if the resolved ffmpeg is ≥ 8. **Prod note for the future:** the day the Ubuntu box gets ffmpeg ≥ 8, every MP4 upload dies the same way — a one-line `-fps_mode passthrough` change is the fix, its own item. |
| Server binds like prod | **`reusePort: true` in `server.listen` (`server/index.ts:171`) throws `ENOTSUP` on macOS with Node 25 on every port** (tested 5000 and 5001 with a bare `http.createServer`); port 5000 is additionally owned by macOS AirPlay Receiver (`ControlCenter` on `commplex-main`). | **One app change, own commit, prod-neutral:** `reusePort: process.platform === "linux"` (Linux behaviour identical; macOS now binds). Sandbox uses `PORT=5001`. Flagged in the report. |
| `Kidney.mp4` for the first-run gate | Not on this machine. | Gate run with `sandbox/clips/butterfly/bfly_z2b.mp4` (295 f, 632×1080) and a GE multiframe DICOM. Andre re-runs the gate with `Kidney.mp4` when he adds it. |

---

## 1. DB (design §2.1-1, amendment §4-1)

- **Boot behaviour.** `server/storage.ts:17,287-296` — the live store is `new PgStorage()`; importing it loads `server/db.ts`, which **throws at import if `DATABASE_URL` is unset** (`db.ts:12-17`). With it set, `server/index.ts:43-105` runs the 5C-2 eager probe: logs `app DATABASE_URL target → host:port/db user=…` (`:62-70`), then `SELECT current_database(), current_user, current_schema(), to_regclass('public.jobs') IS NOT NULL` (`:79-81`) and **`process.exit(1)` if `public.jobs` is missing (`:88-102`) or the DB is unreachable (`:103-110`)**. So a local URL works exactly like RDS does, provided the schema is migrated first.
- **SSL.** `server/dbSsl.ts:25-39` — SSL is enabled only if the host contains `rds.amazonaws.com` **or** the URL has an `sslmode` other than `disable`. A plain `postgresql://masq@localhost:5433/masq` → `ssl: undefined` → SSL off, which a Homebrew cluster needs (it has no server cert). `sslmode=disable` also works; `sslmode=no-verify` would wrongly *enable* SSL (`:37`). The pool: `server/db.ts:21` `new Pool({ connectionString, ssl: resolveSsl(connectionString) })`. Same function in `drizzle.config.ts:4,17` for migrations — same decision on both paths.
- **Migrations.** `drizzle-kit migrate` (`package.json` → `db:migrate`), journal `migrations/meta/_journal.json`, one migration `migrations/0000_hard_cable.sql` creating `jobs`, `ai_runs`, `frame_processing_batches` (the A3 schema). `drizzle.config.ts:6-8` throws without `DATABASE_URL`; there is **no other env path** (no `DRIZZLE_URL`, no `TEST_DATABASE_URL` in the config — that one is only read by `scripts/conformance-storage.ts:20-22`). Applied here with `DATABASE_URL=postgresql://masq@localhost:5433/masq npm run db:migrate` (inside `up.sh`).
- **Prod RDS is never referenced** by the sandbox: `up.sh` refuses a `DATABASE_URL` that is not `localhost:5433` or that contains `rds.amazonaws.com`. There is no `.env` in the checkout (only `.env.example`); the server reads `process.env` directly (no dotenv import anywhere in `server/`), so the env comes from the shell that starts it.
- **Sessions:** `connect-pg-simple` is in `package.json` but **unused** (grep `connect-pg-simple|express-session` in `server/` → 0 hits). No session table needed.

## 2. Serving (design §2.1-2, amendment §4-2)

- One process, one port: `server/index.ts:167-180` listens on `PORT` (default 5000, host `0.0.0.0`). Dev: `setupVite` (`vite.ts:22-64`) mounts Vite middleware + an `index.html` catch-all after all API routes (`index.ts:155-162`, comment says why). Prod: `serveStatic` from `dist/public` (`vite.ts:66-84`).
- **Frames endpoint** (`server/routes.ts:1588-1723`) reads `temp_extracted/<jobId>/` via `listRawFrameFiles` → `TEMP_EXTRACTED_DIR = path.resolve(process.cwd(), 'temp_extracted')` (`cleanup.ts:43`). All roots are **`process.cwd()`-relative** (`cleanup.ts:42-50`; multer `dest: 'uploads/'` at `routes.ts:56,78`), so the server must be started from the repo root — `up.sh` does `cd "$SB_REPO"`.
- **Socket.IO CORS.** `routes.ts:108-125`: default allow-list is the two prod origins **plus `http://localhost:5000` when `NODE_ENV !== 'production'`** (`:117`); `ALLOWED_ORIGINS` overrides. The sandbox env sets `ALLOWED_ORIGINS=http://localhost:5000` explicitly. Because Vite is same-origin, the Socket.IO handshake origin *is* `http://localhost:5000` — no 5173 to allow.
- Download route and the AI-run ZIPs are plain Express routes on the same port; nothing in them is origin-specific.

## 3. Binaries (design §2.1-3)

- **ffmpeg/ffprobe from `PATH` only.** `server/services/frameExtractor.ts:1` imports `fluent-ffmpeg`; there is **no** `setFfmpegPath`/`setFfprobePath`, no `FFMPEG_PATH` env, no `ffmpeg-static` (grep across `server/`, `shared/`, `package.json` → 0 hits). `server/utils/systemCheck.ts:23-40` runs `ffmpeg -version` / `ffprobe -version` at boot and only *warns* if missing (`index.ts:176-178`; `displaySystemStatus` `:49-72`: "Video file uploads will fail! DICOM and image files will work normally"). **ffprobe is required** for MP4 metadata (`frameExtractor.ts:86` `ffmpeg.ffprobe`), which the `imageio-ffmpeg` bundle used by the spike does not provide — hence the Homebrew install. `up.sh` fails fast if either is missing.
- **DICOM needs nothing external**: `dcmjs` (`frameExtractor.ts:6`) + `sharp`. Uncompressed Explicit VR LE only (CLAUDE.md "Known untested boundary").

## 4. Third parties (design §2.1-4, amendment §4-3)

| what | where | sandbox behaviour |
|---|---|---|
| PostHog | `client/src/lib/posthog.ts:5` hardcoded key | fires two metadata events to the prod project; no crash, no switch (see §0) |
| Anthropic (intent parser) | `server/services/intentParser.ts`, `ANTHROPIC_API_KEY` | unset → keyword path (7A-4); AI spoke only |
| GPU services | `routes.ts:1098,1103` `AI_SERVICE_URL` default `http://localhost:8000`; `.env.example` `SAM2_SERVICE_URL` | pointed at `http://127.0.0.1:9` in `.env.sandbox` → connection refused immediately; **template-mask spoke never calls them** |
| S3 / SES / AWS SDK | grep `S3|aws-sdk|@aws|SES` in `server/` → **0 hits** | nothing reaches out; files are local disk |
| Replit plugins | `vite.config.ts:11-17` cartographer only when `REPL_ID` set; `runtimeErrorOverlay` always | harmless |

## 5. Directories (design §2.1-5)

Created at boot, all `process.cwd()`-relative: `uploads/` (`cleanup.ts:284`, inside `purgeUploadsOnStartup`), `temp_processed/` (`:330`), `spokes/{template_mask,ai,labeling}` (`ensureSpokeDirectories` `:369-377`, log line "Spoke directories ensured"), `TempFolderManager.initialize()` (`templateMaskFolderManager.ts:130`, `index.ts:128`). `temp_extracted/<jobId>/` is created lazily per job (`videoProcessor.ts:1401` `fs.mkdir(rawDir, { recursive: true })`). **No absolute paths** other than `path.resolve(process.cwd(), …)`. Nothing else is expected to pre-exist.

## 6. Cleanup scheduler (design §2.1-6)

Runs in dev exactly as in prod (`index.ts:130-143` → `startCleanupScheduler()` unconditionally; `NODE_ENV` is not consulted in `cleanup.ts`). Effects on a sandbox session: (a) each `up.sh` boot empties `uploads/` and `temp_processed/`; (b) at every `:00` files older than 2 h in `uploads/`, 6 h in `temp_extracted/`, 24 h in `spokes/*` are deleted. Video/DICOM jobs stay applyable for 6 h (reuse path); image batches for 2 h and not across a restart (items 28/30). No knob; `scripts/cleanup-now.ts` exists for manual sweeps. **Recommendation (separate one-line item, own revert):** `CLEANUP_DISABLED=1` short-circuit in `startCleanupScheduler` + `purge*OnStartup`, default off — never set on prod.

## 7. Anything else that blocks a clean local upload → draw → apply cycle (amendment §4-3)

- `express.json({ limit: '50mb' })` (`index.ts:10`) — the `canvasDataUrl` payload fits.
- Node **v25.6.1** + `tsx` 4.19.2 run the server (`npx tsx --version` OK). `pg` is default-imported for ESM (`db.ts:1-5`). No `node_modules` rebuild needed for `sharp` on arm64 (already used by the spike timing).
- Upload size caps: 500 MB video (`routes.ts:58`), 50 MB per image (`:80`). The largest local DICOM is 269 MB — within cap.
- `reusePort: true` on `listen` (`index.ts:171`) is fine on macOS.
- Nothing else found. The first-run gate (report §2) is the proof.

## 8. Open decisions for whoever runs the sandbox
1. Keep trust auth on the local cluster (no password, localhost only) or set one — trust is fine on a single-user FileVault Mac; `.env.sandbox` documents both forms.
2. Whether to add the `CLEANUP_DISABLED` knob (§6) before long sessions.
3. Whether to block PostHog at the browser/hosts level during sandbox use (§4).

## 9. Do not touch
`deploy.sh`, the server's `.env`/PM2 env, RDS, `server/storage.ts`, `server/pgStorage.ts`, `shared/schema.ts`, `migrations/`, `server/services/cleanup.ts`, extraction/apply code. Sandbox adds only `scripts/sandbox/*`, one `.gitignore` line (`sandbox/`), and files under `../sandbox/`.

## 10. Verification plan (the sandbox's own gate — results in `AUTOMASK_SANDBOX_REPORT.md`)
| # | step | pass |
|---|---|---|
| S1 | `up.sh --db-only` on a fresh `sandbox/db` | cluster up on 5433, `public.jobs` present, `status.sh` shows 0 jobs |
| S2 | `up.sh` | boot log: `app DATABASE_URL target → localhost:5433/masq user=masq`, `database reachable … public.jobs=true`, `FFmpeg: INSTALLED`, `serving on port 5000` |
| S3 | upload an MP4, open the template spoke | `bg_extract.first_frame_on_disk` ≤ 2 s; canvas paints during `extracting`; `status` → `ready` with parity |
| S4 | draw, Apply, download | `apply.source: reuse`; ZIP opens; masked frame count = `totalFrames`; `mask_data` present in `jobs` |
| S5 | DICOM multiframe upload → draw → Apply → download | same as S3/S4 on the DICOM branch |
| S6 | `AUTOMASK` unset, repeat S3 | behaviour identical (there is no automask code yet, so this is the baseline S3) |
| S7 | `reset.sh --yes` | 0 jobs; working dirs empty; clips untouched |
