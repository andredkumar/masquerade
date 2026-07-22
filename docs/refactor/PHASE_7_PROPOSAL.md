# Phase 7 Proposal — Pre-Testing Hardening & Cleanup

Proposal only — **no production code in this document.** Per the kickoff: proposal first, then
implement **7A only** after sign-off, then `PHASE_7A_REPORT.md`. **7B is PLAN-ONLY** — its
one-way doors are not executed this session; each 7B item carries a static sweep result plus the
**live-verification gate** the operator runs during/after the heavy testing period.

Every item below was re-confirmed against **current source** (backlog line numbers are known to
drift — all references here are freshly located). Where my source reading disagrees with the
kickoff's provisional classification, I say so.

## Baseline (confirmed this session)

- `npx tsc --noEmit` from `masquerade-aws-latest/` → **17 errors**, verbatim: 10 in
  `server/services/frameExtractor.ts`, 7 in `server/services/maskWorker.ts` (full list under 7A-5).
  Items 7A-1..7A-4 and 7A-6 must add **zero** new errors against this 17. **7A-5 is the only item
  permitted to move the baseline** (target 0) and is sequenced LAST.
- A3 storage/schema/status/shim/conformance/`migrations/` — **untouched by every Phase 7 item.**
- No commercial work (auth/HIPAA/billing/multi-tenancy). No new committed secrets.

---

# Phase 7A — safe, reversible (implement after sign-off)

## 7A-1 — Socket.IO CORS tightening  *(backlog item 17)*

**Current source** — `server/routes.ts:100-105`:
```ts
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
```

**Context that shapes the fix:** the app serves API **and** client from one Express port
(`index.ts`: `serveStatic` in prod, `setupVite` middleware in dev — both on `PORT`, default 5000).
The browser therefore opens the Socket.IO connection **same-origin**: `https://masqueradeimage.com`
in prod, `http://localhost:5000` in dev. There is no separate front-end origin to whitelist beyond
those.

**Change (proposed):** replace `origin: "*"` with an explicit allow-list, env-driven so dev isn't
broken, prod origin as the built-in default:
- Default (no env): `["https://masqueradeimage.com"]`.
- If `NODE_ENV !== 'production'`: also allow `http://localhost:5000` (and, if the operator ever runs
  a standalone Vite dev server, `http://localhost:5173` — confirm the actual dev port before adding;
  current dev is same-port via `setupVite`, so `:5000` is the real one).
- Optional `ALLOWED_ORIGINS` env (comma-separated) overrides the default list, so the operator can
  add an origin without a code change.

**Classification:** **7A** — a config value, trivially revertible (restore `origin: "*"`).

**⚠️ Verification (mandatory, from the prod domain):** a wrong list silently kills the WebSocket →
no live progress. Smoke test = **a real upload on `https://masqueradeimage.com` with the progress
bar advancing** (proves the handshake passed CORS). Boot logs do NOT prove this.

---

## 7A-2 — Remove the Express request-dump middleware  *(backlog item 8 note)*

**Current source** — `server/index.ts:9-21`:
```ts
// Debug middleware to log ALL requests (including PUT/PATCH)
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    console.log('\n🔍 EXPRESS ALL POST/PUT/PATCH REQUESTS:');
    console.log('=======================================');
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Content-Length:', req.headers['content-length']);
    console.log('=======================================\n');
  }
  next();
});
```

**No-side-effects confirmation:** the block only reads `req.method`/`req.url`/`req.headers`, calls
`console.log`, then `next()`. It does **not** mutate headers, does not consume the body (it runs
**before** `express.json()` at `:23`, and reads no `req.body`), and nothing downstream depends on
it. The separate API-response logger at `:26-54` is a different, load-bearing block and is **not**
touched. Removing `:9-21` is pure noise removal.

**Change:** delete lines 9-21.

**Classification:** **7A** — reversible (re-add the block). Confirmed no behavior change beyond
log volume.

---

## 7A-3 — First-paint 0% progress flicker  *(diagnose-before-fix)*

**Diagnosis (confirmed from source, not just the hypothesis):** `ProcessingStatus` learns progress
**only** from the WebSocket; it has no initial snapshot.
- `client/src/components/ProcessingStatus.tsx:17` — `const [progress, setProgress] = useState<ProcessingProgress | null>(null);`
- Render sites coerce null → 0: `:145` `value={currentProgress?.progress || 0}`, `:172`, `:178`
  `{Math.round(currentProgress?.progress || 0)}%`, `:194`.
- The React-Query poll at `:24-28` fetches `GET /api/jobs/:jobId` (a `Job` record with **no
  `progress` field**), so it cannot seed the value.
- The server `join` handler (`routes.ts:1147-1150`) joins the room but emits **no** initial
  snapshot; progress only starts at the first `io.to(jobId).emit('progress', …)`
  (`videoProcessor.ts:1084`).

So on first paint `progress === null → 0%` renders for one beat until the first socket event. The
"missing initial value" framing is **confirmed** (it is not a subscription race — the `join` +
`socket.on('progress')` are set up correctly; the gap is purely the absent initial value).

**Change (proposed, minimal, frontend-only):** guard the render — while connected but
`progress === null`, show an indeterminate "Connecting to processing updates…" state instead of a
literal 0%. No new endpoint, no backend/API-contract change. (A backend "emit snapshot on join" or a
new `GET …/progress` endpoint would also work but is more surface area than the flicker warrants —
rejected for this phase.)

**Classification:** **7A** — frontend-only, reversible.

---

## 7A-4 — `ANTHROPIC_API_KEY` invalid on prod  *(mostly operator/runbook)*

**Current source** — `server/services/intentParser.ts`:
- Two-stage parser: `parse()` (`:44`) runs **Stage-1 deterministic keyword matching first**
  (`:47-102`); only ambiguous/low-confidence commands escalate to Stage-2 `parseWithClaude()`.
- `parseWithClaude()` reads the key at `:120` `const apiKey = process.env.ANTHROPIC_API_KEY;`
  - **Unset:** `:121-124` warn + `clarifyFallback()` — graceful.
  - **Set-but-invalid:** `client.messages.create()` (`:128`) throws (401) → caught at `:165` →
    `console.error('Claude intent parsing failed:', err)` + `clarifyFallback()` — graceful, no crash.

**Correction to the backlog wording:** the backlog says the parser "falls back to the keyword path."
Precisely: keyword matching is the **primary** stage (Stage 1). When the key is invalid, only the
**ambiguous** commands that would have escalated to Claude degrade — and they degrade to
`clarifyFallback()` (an "I didn't understand — try …" prompt), **not** to keyword output. Commands
with recognizable keywords never call Claude and are unaffected. The fallback is graceful either
way.

**Scope for this phase:** this is an **operator/secret fix, not a code bug** — set a valid
`ANTHROPIC_API_KEY` in the PM2 env (no `dotenv` in this project; must be a real env var via
ecosystem `env` / `--update-env`, same mechanism as `DATABASE_URL`). **No key is ever committed.**
→ Written up as a **runbook instruction**, not a code change.

**One optional, minimal code observation (operator's call, not forced):** an invalid key logs
`console.error` on **every** ambiguous command (noisy, and indistinguishable from a JSON-parse
failure). A one-line warn-**once** dedup could quiet it. I am **not** proposing it as a required
change (it is cosmetic log hygiene); flagged here so the operator can opt in. If opted in, it stays
7A (log-only, no behavior change).

**Classification:** **operator-runbook** (primary); optional log-dedup is 7A if chosen.

---

## 7A-5 — The 17 pre-existing `tsc` errors  *(sequence LAST; changes the baseline)*

Full current set (verbatim):

**`frameExtractor.ts` (10):**
| Line | Code | Error | Proposed disposition |
|---|---|---|---|
| 6,24 | TS7016 | `dcmjs` has no declaration file (implicit any) | **Fix** — add a minimal `declare module 'dcmjs';` ambient `.d.ts`. Not a bug; the lib genuinely ships no types. |
| 358,68 | TS18046 | `e` is `unknown` (catch var) | **Fix** — `e instanceof Error ? e.message : String(e)`. Behavior-preserving. |
| 849,75 | TS18046 | `error` is `unknown` (catch var) | **Fix** — same pattern. |
| 524,29 / 525,29 | TS2802 | `Uint16Array` needs `--downlevelIteration`/es2015 target to iterate | **Fix at call site** — wrap in `Array.from(...)` at the two spots (avoids changing the tsconfig `target`, which has wider blast radius). |
| 326,50 / 365,59 / 378,79 / 402,59 / 408,55 | TS18048 | `pixelBuffer` possibly `undefined` | **Judgment — needs a real look.** If `pixelBuffer` is provably assigned before these reads, a narrowing guard/assert is behavior-preserving. If it can genuinely be `undefined`, this masks a latent bug → **do not blanket-suppress**; propose the guard that matches the real control flow. Flagged for careful per-site review in the report. |

**`maskWorker.ts` (7):**
| Line | Code | Error | Proposed disposition |
|---|---|---|---|
| 164,13 / 174,13 | TS2461 | union `{x,y,width,height} | number[]` used as array | **Judgment/real fix** — narrow the union (discriminate object-bbox vs `number[]`) before array ops. Treating an object as an array would be a latent bug — narrow, don't suppress. |
| 185,48 | TS2339 | `.length` not on that union | same union fix as above |
| 186,24 / 186,51 | TS7053 | implicit-any index into the union | same union fix as above |
| 207,16 / 209,91 | TS2339 | `feather` not on `MaskData` | **Judgment** — if `feather` is a real runtime field, add `feather?: number` to the `MaskData` type (behavior-preserving). If it's always `undefined`, the read is a latent bug → flag. |

**Summary:** ~5 are trivial, behavior-preserving fixes (dcmjs decl, 2 catch vars, 2 `Array.from`).
The remaining ~12 (`pixelBuffer` undefined ×5, the `maskWorker` bbox-union ×5, `feather` ×2) are
**type-narrowing that could each expose a real latent bug** — the kickoff explicitly says do NOT
blanket-`@ts-expect-error` those. Plan: fix the trivial set, then narrow the union/undefined sites
with guards that match the actual control flow; **any site where narrowing reveals a genuine runtime
path gets escalated in the report, not silently suppressed.** Target baseline **0**; the report will
state the exact new N and list per-error fix-vs-suppress.

**Classification:** **7A, sequenced last** so the "no new errors" check on 7A-1..4/7A-6 runs against
the known 17.

---

## 7A-6 — Vite chunk-size warning  *(backlog item 13)*

**Diagnosis:** one monolithic bundle, **661 KB** (209 KB gzip). `vite.config.ts:27-30` has **no**
`manualChunks` / `chunkSizeWarningLimit` / `rollupOptions`. `client/src/App.tsx:6-13` statically
imports all 8 pages; there is **no** `React.lazy`/dynamic `import()` anywhere in the client. Heavy
weight is Radix UI (~22 pkgs), Framer Motion, Lucide, Socket.IO client, React Query — all pulled
into the initial chunk. (Fabric.js is an external CDN `<script>`, not bundled; Anthropic SDK + dcmjs
are server-only, not in the client bundle; Recharts is imported by a UI wrapper but used by no page.)

**Change (proposed, low-risk, isolated):** route-level `React.lazy` + `Suspense` for the two spoke
pages — `AiSpokePage` (`/jobs/:jobId/ai`) and `TemplateMaskSpokePage` (`/jobs/:jobId/template-mask`)
— the largest self-contained, optional-flow routes (CommandInput ~785 LOC, MaskingCanvas ~1294 LOC,
FrameViewer). Est. ~150-200 KB off the initial load. One-line-per-route change, fully reversible.

**Caution honored:** this is the only 7A item that touches the build. It must be verified with a
clean `npm run build` **and** a live click-through of both lazy routes (Suspense fallback renders,
route loads) — note the wouter nested-`<Route>` + Suspense integration specifically. **If the build
warns/breaks or the nested-route Suspense misbehaves, downgrade to "nice-to-have" and skip** rather
than risk the build before a testing period (per the kickoff's explicit out).

**Classification:** **7A only if the build stays clean**; otherwise **defer** and say so in the report.

---

## 7A-7 — `attached_assets/` not in git  *(decision only — no implementation)*

**Current state (measured):** `attached_assets/` = **8.1 MB, 65 files** — a **mix**: sample PNG
frames (`frame_000001_*.png`), UI screenshots (`Screenshot 2025-…png`), design-prompt dumps
(`Pasted-*.txt`, `*-overview_*.ts`), and a stray `metadata_*.csv`. Notably, **some are already
git-tracked** (`git ls-files` returns the `Pasted-*.txt` prompt dumps); the **binaries are not**.
It is **not** in `.gitignore`. This looks like **developer scratch/reference material**, not a
runtime asset dir.

**Open question that decides the recommendation:** does anything read `attached_assets/` at
**runtime**? A grep of `server/`/`client/` for `attached_assets` should be run to confirm; the
backlog's "populated server-side" phrasing suggests it may be a scratch output, not a served asset.

**Recommendation (decision-only, tradeoffs):**
- **If nothing reads it at runtime (likely):** do **not** commit 8 MB of binaries (permanent git
  bloat) and do **not** wire S3 (no runtime need). Instead: add `attached_assets/` to `.gitignore`,
  and (separately) decide whether to *untrack* the few `Pasted-*.txt` already committed or leave
  them as harmless history. Net: keep the dir local/archived, out of the repo.
- **If it is a runtime-served asset dir:** migrate to **S3-served URLs** (durable, off the EBS
  volume, survives instance replacement) — but that's a follow-up implementation, not this phase.

**Classification:** **proposal recommendation only** — no code/commit/S3 wiring in Phase 7. Blast
radius (large-binary commit vs S3 wiring) keeps both out of a pre-testing hardening pass.

---

# Phase 7B — one-way doors (PLAN ONLY — do NOT execute this session)

## 7B-1 — Remove `POST /api/videos/:jobId/process`  *(backlog item 16)*

**Current source:** registered at `server/routes.ts:437`
(`app.post("/api/videos/:jobId/process", …)`) — a full legacy processing handler (~90 lines,
`storage.getVideoJob` → `videoProcessor.processImages`/`processVideo`).

**Static sweep result (this session, exhaustive incl. dynamic construction):** **zero client
callers.**
- No `/api/videos/…/process` literal anywhere in `client/src`.
- No `['/api/videos', jobId]` queryKey array (the known 4d-1b blind spot); the only `/api/videos`
  occurrence in `client/` is a **comment** in `template-mask-spoke.tsx:86` documenting a Phase-4d-1b
  **removal** — not a live call.
- No template-literal / base-path / segment-join construction of the URL.
- No server-internal caller or re-registration/alias.
- The live processing path all spokes actually use is **`POST /api/jobs/:jobId/template-mask/apply`**
  (`client/src/components/ProcessingControls.tsx:85` → handler `routes.ts:1585`).

**⚠️ Static grep is necessary but NOT sufficient** (binding Phase-4 lesson; HTTP 200 ≠ removal proof
because the SPA catch-all serves `index.html` for unmatched routes).

**LIVE-VERIFICATION GATE (operator runs before removal):**
1. **Instrument:** add a one-line `console.log('[DEADROUTE-HIT] /api/videos/:jobId/process', …)` at
   the top of the `:437` handler (temporary, reversible), deploy.
2. **Exercise:** across the testing period, run a **representative pass of every workflow** — image
   upload + template-mask apply, video upload + apply, AI run, both downloads, both spokes.
3. **Confirm ZERO `[DEADROUTE-HIT]` lines** in the PM2 logs across that window.
4. **Bundle grep:** confirm the built client bundle (`dist/public/index-*.js`) contains no
   `/api/videos` + `/process` construction (source grep alone isn't the shipped artifact).
5. Only after **(3) clean live sweep AND (4) clean bundle grep** is removal authorized — then delete
   `:437`'s handler in a **separate, isolated one-way-door commit**.

**Do NOT remove this session.**

## 7B-2 — `5B-1c` dead-code lead — **BLOCKED, could not re-confirm**

**Finding (this session):** the recorded `routes.ts:361` reference is **stale/wrong** — current
line 361 is **live code** (inside the image-batch `fileList`/`jobData` builder,
`routes.ts:~334-366`, reached on every multi-image upload → `createVideoJob`). A history/report
sweep (`PHASE_5B_PROPOSAL.md:81-91`, `PHASE_5B_REPORT.md:23-26`, all `5B-1c` hits) shows Phase 5B
**already** hit this exact wall and parked it pending a corrected reference. No alternative dead
construct matching the "5B-1c" description was found in current source.

**Honest output (the acceptable one per the kickoff):** **"could not re-confirm; needs operator /
planning input."** No removal target exists. **Do NOT remove line 361 or anything adjacent.** This
item stays parked until the operator re-cites the original dead block (or drops it).

**No live gate applicable** — there is nothing identified to gate.

## 7B-3 — Drop `temp_processed/` from `SWEEP_TARGETS` + `purgeTempProcessedOnStartup`  *(5B-4 / item 4)*

**Current source:**
- `cleanup.ts:45` `TEMP_PROCESSED_DIR`; `:65-72` `SWEEP_TARGETS` includes it at `:68` (already
  annotated `// … remove once confirmed no writes occur`); `:328` `purgeTempProcessedOnStartup()`.
- Called at boot: `server/index.ts:135` (import) + `:140` (`await purgeTempProcessedOnStartup()`).

**Static status:** 5B already static-confirmed **no code writes to `temp_processed/`** (the remaining
mentions are comments). So the only thing missing is **runtime "quiet" evidence.**

**WAIT-AND-WATCH GATE (the testing period IS the evidence window):**
1. Before/at the start of testing, confirm `temp_processed/` is empty on the host.
2. Across the **entire heavy-testing period**, with the app under representative load, confirm the
   dir **stays empty** — nothing ever writes there. (Spot-check via `ls temp_processed/` periodically
   and/or a temporary inotify/`find -newer` watch.)
3. **Define "clean window" concretely:** the dir observed **empty for ≥ the full testing period AND
   ≥ 7 continuous days of real use**, whichever is longer, with zero files ever appearing.
4. Only after a clean window: remove `temp_processed` from `SWEEP_TARGETS` (`:68`), delete
   `purgeTempProcessedOnStartup` (`:328`) and its two call sites (`index.ts:135/140`), and the
   `TEMP_PROCESSED_DIR` const if then unused — in a **separate** commit.

**Do NOT remove this session.**

## 7B-4 — Item 15: download masked-vs-raw asymmetry  *(operator decision)*

**Current source:** the whole-job `templateMaskDownloadHandler` 404s when the template-mask dir is
empty — `routes.ts:552-554`:
```ts
const { dir: tempDir, files: frameFiles } = await listFrameFiles(job.id);
if (frameFiles.length === 0) {
  return res.status(404).json({ error: "Processed frames not found on disk" });
}
```
The **run** download (Phase 6) has masked-first/raw-fallback for base frames; the whole-job download
deliberately does **not** (the ratified Phase-6 asymmetry).

**Two options (tradeoffs):**
- **(A) Unify** — give the whole-job handler the same raw fallback, so a no-mask job exports raw
  extracted frames instead of 404. *Pro:* consistent, never a dead-end download. *Con:* a
  "template-mask download" that returns **unmasked** frames is semantically misleading; it also
  erodes the honest "no mask applied → nothing to download" signal, and widens blast radius on the
  whole-job path right before testing.
- **(B) Leave documented (recommended)** — keep the 404; it correctly means "no template-mask
  product exists for this job." The run download already covers the "give me the frames the AI ran
  on" need. *Pro:* honest UX, zero code change, zero risk. *Con:* the two download paths stay
  intentionally asymmetric (already documented).

**Recommendation: (B) leave documented.** It is a **product decision for the operator**, not a code
task — do not implement either this session.

---

# Observations (noticed-but-parked — recorded, not fixed)

- **`GET /api/jobs/:jobId/progress` does not exist.** `storage.getProcessingProgress()` exists
  (`storage.ts`) but is not exposed over HTTP; this is why 7A-3 can't seed from REST. Not needed for
  the chosen 7A-3 fix; noted only.
- **Recharts is bundled but used by no page** (only a `ui/chart.tsx` wrapper). A potential future
  bundle trim; out of 7A-6's low-risk route-split scope.
- **`deployment-package/`** remains a stale tracked build snapshot, not the live source tree — no
  Phase 7 item should edit it. (Consistent with the 5C-2 note.)
- No new issues requiring action were found while reading; anything spotted is recorded here per the
  kickoff rather than fixed.

# Open questions for the operator

1. **7A-1:** confirm the allowed-origin list — is `https://masqueradeimage.com` the sole prod origin
   (any `www.` or apex/alt domain to add)? Is there ever a standalone Vite dev server (`:5173`), or
   is dev always same-port (`:5000`) via `setupVite`?
2. **7A-4:** confirm this is purely the missing/invalid prod key (operator sets it) — or do you want
   the optional warn-once log-dedup landed too?
3. **7A-6:** are you comfortable with the route-level lazy-load touching the build now, or would you
   rather defer it until after the testing period (I'll skip it cleanly if you prefer zero build risk
   pre-testing)?
4. **7A-7:** does anything read `attached_assets/` at **runtime**? If not, I recommend gitignore
   (not commit, not S3). Confirm the direction so it can be actioned in a follow-up.
5. **7B-4:** your call on (A) unify vs (B) leave-documented — I recommend (B).

# Output plan (post-sign-off)

Implement **7A only**, sequencing **7A-5 last**. Every 7A item verified for **zero new tsc errors**
against 17 until 7A-5 lands the new baseline (target 0), which the report states explicitly. Then
`docs/refactor/PHASE_7A_REPORT.md`. **7B stays planned, not executed** — its gates run during the
operator's testing period.
