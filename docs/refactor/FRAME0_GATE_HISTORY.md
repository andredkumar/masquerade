# Why "draw the mask while frames extract" got blocked — the paper trail

**Written:** 2026-08-30, from `docs/refactor/PHASE_1_REPORT.md`, `PHASE_4A_REPORT.md`, `PHASE_4B_RECON.md`,
`PHASE_4B_REPORT.md`, `PHASE_4B0_PROPOSAL.md`, `PHASE_4B0_REPORT.md`, and `MASQUERADE_HANDOFF.md` (Q0).
**Bottom line:** no error ever forced the block. It was a defensive default written into a design doc in
Phase 4b, when frames lived in RAM, and every later phase preserved it verbatim as "no change."

## Timeline

| When | Doc | What happened to frame 0 |
|---|---|---|
| Pre-refactor (legacy `home.tsx`) | `PHASE_1_REPORT.md:18` | Upload handler extracts frame 0 **synchronously** and returns it as base64 in the upload response. `home.tsx` holds it in state and the canvas renders it immediately. Background extraction runs after the 200. **Drawing while extracting worked.** |
| Phase 3d / handoff Q0 (May 2026) | `MASQUERADE_HANDOFF.md` §5 Q0 | Decision "Option A": navigate to hub on upload response, extraction continues in background, **"the Template Mask spoke becomes interactive once enough frames exist."** This is the stated intent. |
| Phase 4a (2026-05-12) | `PHASE_4A_REPORT.md:47, :140` | Multi-route SPA needs frame 0 to survive `/upload → /jobs/:id → /template-mask`. Solved with a **sessionStorage cache** (`lib/frameCache.ts`) of the base64 from the upload response. Hub built with an "initializing panel when status !== 'ready'" and spoke tiles **"clickable when ready."** ← first gate, on the hub tile. Acknowledged as interim: "proper solution is a server endpoint in a later phase." |
| Phase 4a hotfix 1 | CLAUDE.md | Tiles *never* unlocked because `Job.status` wasn't mirrored from `VideoJob.status`. Fix was to add the status mirror — i.e. make the gate work, not remove it. (This is probably the "error" you remember.) |
| Phase 4b recon (2026-05-14) | `PHASE_4B_RECON.md` Q5 | Designs `GET /api/jobs/:jobId/frames/:n` to read from **in-memory `global.extractedFrames`**, and specifies `503 "Extraction in progress" if Job.status !== 'ready' (frames not yet available)`. Rationale at the time: frames were a RAM map populated by the batch extractor; the agent treated "extracting" as "nothing to serve." No error, no bug report — a status-code table in a recon doc. ← second gate, on the endpoint. |
| Phase 4b (2026-05-14) | `PHASE_4B_REPORT.md:27-28` | Spoke rewritten to fetch `frames/0`; sessionStorage cache **removed from the upload page** (`cacheUploadData` callsite deleted). The upload response still carries `firstFrame` base64, but nothing consumes it anymore. The spoke's `FrameStatus` state machine renders a spinner on 503. |
| Phase 4b-0 (2026-06-12) | `PHASE_4B0_PROPOSAL.md:116`, `PHASE_4B0_REPORT.md:89` | Raw frames move from RAM to disk (`temp_extracted/<jobId>/frame_%06d.png`). The 503 row is carried over as **"No change"**. This is the moment the gate stopped matching reality: `frame_000001.png` is on disk after the first batch, but the endpoint still refuses on status. |
| Phases 4b-ii → 7A | — | Nobody revisits it. The AI spoke gate is moved *to* `status === 'ready'` in 4b-ii (correctly, for AI — inference needs all frames). Template mask inherits the same gate by symmetry. |

## What this means for Round 2

The block is two independent lines, both premised on a storage model that no longer exists:

1. `server/routes.ts` frames endpoint, raw branch: `if (jobV2.status === 'extracting') return 503`.
   Replace with a file-existence check: serve `frame_000001.png` if it's on disk; 503 only if it isn't yet.
   (410 semantics for swept dirs unchanged.)
2. `client/src/pages/hub.tsx`: `disabled={!isReady}` on the Template Mask tile. Enable it when
   `status === 'extracting' || 'ready'` (leave the AI tile gated on `ready` — inference needs every frame).

Then the spoke needs one guard the legacy flow never had: **Apply must wait for extraction to finish.**
Drawing can start at frame 0; the Apply button stays disabled (with the live extraction progress shown)
until `job.status === 'ready'`. That is the "interactive once enough frames exist" from Q0, done properly.

No storage, schema, or status-model change. tsc unaffected. A3 untouched.
