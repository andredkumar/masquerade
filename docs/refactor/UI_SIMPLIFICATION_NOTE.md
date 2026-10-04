# Masquerade — queue after Output Round 1b, and the UI simplification note (2026-09-23)

## Queued as of 2026-09-23 (prod = `51289ae`: Output Round 1 + 1a + 1b deployed and verified)

1. **Output Round 2 — fail-closed apply + manifest filenames.** Kickoff: `OUTPUT_ROUND2_KICKOFF.md`. The server refuses (synchronous 422, nothing persisted) an apply whose mask blanks nothing or everything, counting with the existing mask builder; `manifest.json` / `metadata.csv` `filename` equals the ZIP entry `images/frame_%06d.<ext>` (backlog 27).
2. **UI simplification — its own conversation, after Output Round 2's kickoff.** Andre, 2026-09-23: Masquerade is a highly technical tool right now, with too many toggles and boxes; make the interface friendlier, cleaner and more streamlined. Suggested starting point for that chat: an inventory of every control on the upload page, hub, template-mask spoke (sidebar tools, Keep/Remove toggle, auto-mask bar and controls, zoom, output settings) and AI spoke, with who needs each one and when, before any code. Candidates to fold in: "review masked frames" in the spoke (`NEXT_ROUND_CANDIDATES.md` Item 2), sensible defaults that hide output settings until asked for, and progressive disclosure of the auto-mask fine controls.
3. Keep-mode `apply.mask_build` cost (2.2–2.6 s of a ~4.5 s Keep apply on 46 × 1080p frames): emit only in-crop offsets inside `buildApplyMask`; needs the pixel-equivalence proof, own round.
4. Auto-mask 2C (B4 template library, B6 temporal support) once the `automask.outcome` pivot has a week of real sessions.
5. Dead code: `processBatchesInParallel`, `maskWorker.ts` (`NEXT_ROUND_CANDIDATES.md` Item 4).

Status of `NEXT_ROUND_CANDIDATES.md` (2026-09-04): **Item 1 (image-batch mislabel, backlog 22) DONE 2026-09-04.** Items 2–5 still open.

