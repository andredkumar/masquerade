# Phase 7A Report — Pre-Testing Hardening (implementation)

**Status: 7A implemented (code) — not yet deployed/verified on prod.** This session implemented
the safe, reversible 7A items ratified in `PHASE_7A_AMENDMENT.md`. 7B remains **plan-only** (not
executed). The deploy runbook is intentionally NOT written here (planning partner's job once this
report is back).

**Scope guardrails honored:** A3 storage/schema/status/shim/conformance/`migrations/` **FROZEN and
untouched**; no commercial work; **no committed secrets**; 7A-6 deferred; only 7A-5 changed the tsc
baseline.

---

## tsc baseline — REBASELINED 17 → **12**

The kickoff's "drive to 0 and retire the =17 rule" was superseded by the amendment: land only the
**5 trivial, behavior-preserving** fixes; **defer** the 12 risky narrowings to their own later pass.

- Before 7A-5 (after 7A-1/7A-2/7A-3): **17** — confirmed unchanged; 7A-1/7A-2/7A-3 added **zero**
  new errors (verified via `npx tsc --noEmit`, count 17, identical error set).
- After 7A-5 (5 trivial fixes): **12** — measured exactly, as expected (17 − 5).

**New project invariant: `tsc` stays at 12. All future phases hold tsc at 12** (was 17 through
Phase 6). Any phase that raises the count above 12 has regressed; the deferred pass (below) is the
only sanctioned path to lower it further.

The remaining **12** (all pre-existing, all deferred by the amendment — untouched, left in a known
state for the deferred pass):
- `frameExtractor.ts` — `pixelBuffer` possibly-undefined ×5: `326`, `365`, `378`, `402`, `408`.
- `maskWorker.ts` — bbox-union not-array / index ×5: `164`, `174`, `185`, `186` (two errors on 186).
- `maskWorker.ts` — `feather` not on `MaskData` ×2: `207`, `209`.

These are **not** blanket-suppressed and have **no** partial narrowing / `@ts-expect-error` on them —
per the amendment, they start the deferred pass exactly as they were.

---

## 7A items — outcomes

### 7A-1 — Socket.IO CORS allow-list — **IMPLEMENTED (code)**
`server/routes.ts` (Socket.IO init, was `origin: "*"`). Replaced with an env-driven allow-list:
- Default (production): `["https://masqueradeimage.com", "https://www.masqueradeimage.com"]` (apex +
  `www.`, both confirmed to point at the app).
- Non-production (`NODE_ENV !== 'production'`): additionally `http://localhost:5000` (the confirmed
  same-port dev origin via `setupVite`). `:5173` deliberately **not** added.
- `ALLOWED_ORIGINS` env (comma-separated) overrides the default list entirely if set — a future
  origin needs no code change.

**Verification status: NOT yet verified.** Requires the mandatory prod smoke test (below) — a real
upload with the **progress bar advancing**, loaded once via `https://masqueradeimage.com` and once
via `https://www.masqueradeimage.com`. Boot logs do not prove the WebSocket handshake passed CORS.
Reversible: it's a config value; revert = restore `origin: "*"`.

### 7A-2 — Remove request-dump middleware — **IMPLEMENTED (code)**
`server/index.ts`. Deleted the debug middleware that logged every POST/PUT/PATCH (was `:9–21`).
Confirmed pure logging (read `req.method`/`req.url`/headers, `console.log`, `next()`), ran **before**
`express.json`, consumed no body, mutated nothing downstream. The load-bearing API-response logger
(the `res.json` capture + `res.on("finish")` `/api` log line) is **untouched**.

### 7A-3 — First-paint 0% flicker — **IMPLEMENTED (code, frontend-only)**
`client/src/components/ProcessingStatus.tsx`. Root cause confirmed: granular progress is
WebSocket-only; on first paint the 2 s job poll (`jobData`) can arrive before the first `progress`
event, so `currentProgress` is `null` and the UI rendered literal `0 / 0 frames` + `0%`. Added an
additive indeterminate branch — when we have a job but `currentProgress === null` and the job isn't
already `complete`, render an indeterminate `<Progress />` and the text **"Connecting to processing
updates…"** (with the "Live" indicator when the socket is connected) instead of 0%. Self-healing:
falls through the moment a `progress` event lands or the poll reports `complete`. No new endpoint,
no API-contract change. Reversible: delete the branch.

**Verification status: NOT yet verified on a running client** (no dev server exercised this
session). Visual check owed at deploy: fresh upload should show "Connecting…", not a 0% beat.

### 7A-4 — `ANTHROPIC_API_KEY` — **OPERATOR-RUNBOOK (no code)**
No code changed. `intentParser.ts` left **unchanged** (optional log-dedup declined by the operator).
Confirmed the fallback is graceful: the keyword path is Stage-1 **primary**; an invalid key only
degrades *ambiguous* commands to the clarify-fallback (no crash). Fix is operational — set a valid
key in the PM2 environment (same mechanism as `DATABASE_URL`; no `dotenv` in this project). **No key
committed.** The exact steps belong in the deploy runbook (planning partner).

### 7A-5 — tsc trivial subset — **IMPLEMENTED (code); baseline 17 → 12**
Sequenced last. Landed exactly the 5 behavior-preserving fixes:
1. `dcmjs` ambient declaration — new file `server/types/dcmjs.d.ts` containing `declare module
   'dcmjs';` (picked up by tsconfig `include: server/**/*`). Cleared TS7016 at `frameExtractor.ts:6`.
2. `frameExtractor.ts:358` — catch var `${e instanceof Error ? e.message : String(e)}`.
3. `frameExtractor.ts:849` — catch var `error instanceof Error ? error.message : String(error)`.
4–5. `frameExtractor.ts:524,525` — wrapped the `Uint16Array` spread in `Array.from(...)`
   (`Math.min/max(...Array.from(uint16Data))`). `tsconfig` `target` **not** changed (wider blast
   radius avoided). Cleared both TS2802.

No surprises — the count dropped from 17 to exactly 12; no "trivial" fix cleared or exposed extra
errors. The 12 deferred sites were not touched.

### 7A-6 — Vite chunk-split — **DEFERRED (accepted, no code)**
Not implemented, per operator decision. `vite.config.ts` unchanged. The 661 KB single-bundle
"chunks larger than 500 kB" warning **persists and is accepted** for the solo testing period. Now a
backlog item (below).

### 7A-7 — `attached_assets/` — **REPORT-AND-STOP branch (no gitignore)**
Grep of `server/` and `client/` for `attached_assets`/`@assets`:
- `vite.config.ts` defines the alias `@assets → attached_assets`.
- **`client/src/pages/landing.tsx:18` imports the hero GIF** from
  `@assets/ezgif-35c303285ed42c_1759721392554.gif` — a real build/runtime dependency.

Because something **does** read it at build/runtime, the amendment's **branch 3** applies: **stopped,
did NOT gitignore.** Additional correction to the backlog's premise: the "attached_assets not in git"
statement is **stale** — all **65** files are already git-tracked (including the 876 KB hero GIF).
Net: no action taken; the directory is already committed and at least one file is load-bearing. If
the operator later wants these off the repo, it becomes a real asset-hosting decision (S3 + a served
route), out of scope here — and would require moving the `landing.tsx` import off `@assets` first.

---

## 7B — plan-only (NOT executed this session)

- **7B-1** — `/api/videos/:jobId/process` (`server/routes.ts`, handler at ~`:453`): handler **not
  removed**. Added the temporary **`[DEADROUTE-HIT]` instrument** — a single `console.warn` as the
  first statement of the handler, logging `jobId` + `origin`/`referer`/`user-agent`. Purpose: let
  the operator confirm **zero** real hits across the testing period. The removal (handler + this
  instrument) is 7B, gated on a clean live sweep **and** a zero-hit source+bundle grep (HTTP 200 ≠
  removal proof — SPA catch-all). **Watch for `[DEADROUTE-HIT]` in prod logs; if it ever fires, the
  route is not dead — investigate before removal.**
- **7B-2** — `5B-1c`: **could not re-confirm** a dead target; `routes.ts:361` is live. No removal.
  Parked pending operator re-citation of the original dead block.
- **7B-3** — `temp_processed/` sweep removal: gate unchanged (dir stays empty across the full
  testing period AND ≥7 continuous days), then remove `cleanup.ts` `SWEEP_TARGETS` entry +
  `purgeTempProcessedOnStartup` + its `index.ts` call. Not removed.
- **7B-4** — download masked-vs-raw asymmetry: operator chose **(B) leave documented**. No code; the
  intentional run-vs-whole-job asymmetry stays as-is.

**7B-1 instrument added: YES** (`server/routes.ts`, first line of the `POST /api/videos/:jobId/process`
handler). It is the only 7B-adjacent code change and is itself removed with the handler in 7B.

---

## Deferred items now on the backlog

- **7A-5 remainder — the 12 tsc narrowings** (5 `frameExtractor.ts` `pixelBuffer` + 5 `maskWorker.ts`
  bbox-union + 2 `maskWorker.ts` `feather`). Own later pass; may expose latent image-processing bugs,
  so not taken on right before heavy testing. Baseline stays **12** until then.
- **7A-6 — Vite chunk-split** (661 KB single bundle). Deferred; the wouter-nested-route + Suspense
  integration is exactly what shouldn't be introduced right before testing.

---

## Files changed this session

Code:
- `server/routes.ts` — 7A-1 CORS allow-list; 7B-1 `[DEADROUTE-HIT]` instrument.
- `server/index.ts` — 7A-2 request-dump middleware removed.
- `client/src/components/ProcessingStatus.tsx` — 7A-3 indeterminate "Connecting…" branch.
- `server/services/frameExtractor.ts` — 7A-5 fixes 2–5 (two catch vars, two `Array.from`).
- `server/types/dcmjs.d.ts` — **new**, 7A-5 fix 1 (`declare module 'dcmjs';`).

Docs:
- `CLAUDE.md` — Phase 7 status block (Edit 1) + backlog reconciliation (Edit 3).
- `docs/refactor/PHASE_7_PROPOSAL.md` — the accepted proposal (created earlier this arc).
- `docs/refactor/PHASE_7A_REPORT.md` — this report.

**No A3/frozen-layer file touched** — verified: no change to `shared/schema.ts`, `server/storage.ts`,
the `PgStorage` shim, `migrations/`, or `scripts/conformance-storage.ts`.

---

## Verification owed at deploy (7A-0 folded in)

None of the below was exercised on a running server this session (agent-environment code changes
only). All are owed on the deployed build:
- **7A-1 CORS live-progress:** real upload with the progress bar advancing, once via the apex host
  and once via `www.` — both must show live progress (proves the WS handshake passed CORS per host).
- **7A-3 flicker:** fresh upload shows "Connecting to processing updates…", not a 0% beat.
- **7A-0 base-frame toggle smoke (owed from Phase 6):** 8a/8b/8c — esp. 8c (raw run → toggle on →
  `images/` populated from raw frames).
- **7A-4:** confirm the valid `ANTHROPIC_API_KEY` is set in the PM2 env (runbook) and the intent
  parser reaches the Claude path (no per-command fallback noise).
- **7B-1 instrument:** confirm `[DEADROUTE-HIT]` is present and the operator watches for it during
  testing.

## Observations (noticed, parked — not fixed)

- No `GET /api/jobs/:jobId/progress` endpoint exists; first-paint progress is inherently
  WebSocket-only. 7A-3 addresses the symptom (no misleading 0%) without adding an endpoint, as the
  amendment directed.
- `deployment-package/` carries its own stale `vite.config.ts` (with the same `@assets` alias). It's
  a build snapshot, not live source; left as-is.
