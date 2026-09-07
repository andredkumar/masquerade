# Auto-mask — Round 2B / 2C kickoff drafts (product requirements carried from Andre's bench sessions)

**Date:** 2026-09-06. **Status:** DRAFT — kickoffs for the rounds after 2A. Section B below is carried **verbatim** from
`AUTOMASK_POST_REREVIEW_NOTES.md` §B (B1–B6) and `AUTOMASK_2A_GO.md` §3 (B7) (Andre's requirements from the bench-v4 review sessions); nothing in it has been
edited or re-interpreted. Section C is the agent's list of what each round inherits from the sandbox passes.

## A. Where 2A stands

2A (proposer + endpoint + eval, flag off, no UI) ports the **frozen** rules in `scripts/automask_spike/CONSTANTS.md`
(frozen 2026-09-06 after pass 3) into `shared/automask/` + `server/services/automask.ts`, per
`AUTOMASK_ROUND2A_PROPOSAL.md` as amended by `AUTOMASK_2A_DECISIONS.md` §3. 2B is the UI on top of the 2A endpoint;
2C is the template library and the temporal-support candidate. Neither starts before 2A's runbook rows are green.

## B. Product requirements for 2B / 2C (from Andre's bench sessions — carried into the kickoffs verbatim)

**B1. The proposal is the default entry to the template-mask spoke (2B).** On open: frame 1 with the proposed cone drawn, the controls, and two primary actions — **Accept** and **Draw from scratch**. Blank canvas on withheld/error/flag-off is exactly today's behaviour. Flag default-off at deploy; flipped to default-on when the corpus is at ≥ 90 % accept-or-controls.

**B2. Controls (2B) — the bench v4 set, not a subset:** half-angle (both sides together), **top width (arc stays)** joint control, top arc height, depth, apex/whole-cone position. Every control shows `fitted → now (Δ)`. Rectangles get width and top/bottom; trapezoids get side angle, top width, top, bottom.

**B3. Nudge ergonomics (2B).** Arrow buttons and keyboard arrows: tap = 1 px; **press-and-hold repeats with acceleration** (≈ 10 px/s after 400 ms, ≈ 40 px/s after 1.5 s); Shift = ×10; drag handle on the apex (fan) / top-edge midpoint (trap/rect) for coarse moves. Sliders: keyboard-adjustable with the same Shift rule.

**B4. Saved cones — the template library (2C, promoted from backlog).**
- Every Accept or corrected-then-Accept saves the final parameters against a **layout fingerprint**: DICOM → manufacturer + model + rows × cols (+ `(0018,6011)` box when present); MP4/PNG → resolution + a hash of the static-furniture map from frame 1 (2A already computes the not-background mask; the fingerprint is a downscaled hash of it outside the cone).
- Matching fingerprint on a later upload → the saved cone is the proposal (`tier: 'template'`, shown as "your saved cone: <name>"), the fitter runs only as a fallback. Users may **name** a saved cone ("iQ3 lung 12 cm") and pick from their list; unnamed ones are matched silently by fingerprint.
- Unknown fingerprint → proposal from the fitter, always reviewed; never auto-applied.
- Per user/org (no auth today → per browser/localStorage until accounts exist; the schema for server-side storage is a 2C decision, not an A3 change now).
- This is the mechanism for the Butterfly-depth gap (no pixel evidence; fixed geometry per export/depth setting → one correction covers the family) and for every future vendor: the first clip from a new device costs the user 30 s, the rest are rubber stamps.

**B5. Telemetry (2B).** One `[PERF] automask.outcome` line per job: Accept / Edit / Dismiss, which controls were used, each Δ, fingerprint id, template hit or miss. This is what sets the grade thresholds and tells us which vendor needs the next tuning pass.

**B7. Model switch (2B) — added 2026-09-06 from `AUTOMASK_2A_GO.md` §3, Andre's requirement from the `2026-09-06_1041` re-review (notes on `bfly_z9` and `sonosite_011_clip10`).** The controls edit parameters; two of the three residual "wrong" verdicts are the wrong *shape family*. 2B adds a three-way switch **fan / trapezoid / rectangle** on the proposal bar. Switching re-seeds the new model from the current shape's geometry (fan → trap: top/bottom widths at `r_in`/`r_out` and the axis; trap → fan: apex from the side lines' intersection, radii from top/bottom; rect ↔ trap: equal widths), so the user lands close and adjusts, never starts from nothing. Telemetry logs the switch.

**B6. Temporal support (2C candidate, after B4).** The three support failures (`bfly_z9`, `sonosite_011_clip10/11`) fail because frame 1 doesn't show the whole cone. A max projection over the clip as the *support* input (not as a depth extender — T2ext stayed at 60 % agreement) is the candidate; evaluate in the sandbox against the same references before it goes near the app.

## C. What each round inherits from the sandbox passes (agent's notes, not requirements)

**2B inherits**
- The bench-v4 controls exist as a parametric renderer in `scripts/automask_spike/bench_static/shape.js` (`controls()`,
  `withParam()`, `deltas()`, `drawProposalLayer()`, `drawMaskRaster()`). 2A ports the *shape* part to
  `shared/automask/shape.ts`; 2B ports the controls. The joint control's closed form is documented in
  `AUTOMASK_PASS2_REPORT.md` §4; the readout bug found there (readouts must be computed from the *current* shape) is the
  kind of thing the 2B tests should cover.
- `fitted → now (Δ)` and the five deltas (`d_half_angle_deg`, `d_apex_px`, `d_top_px`, `d_top_width_px`,
  `d_depth_px`) are already defined in `shape.js`/`bench.py` (`shape_deltas`) — B5's telemetry should emit exactly these,
  plus `d_arc_px` for fans (the visible top; see `AUTOMASK_PASS2_REPORT.md` §1 on why Δ top alone misleads for fans).
- The grade thresholds (`conf`) are unset; B5's first weeks of `automask.outcome` lines set them.
- Known residual misses at freeze (from `AUTOMASK_PASS3_REPORT.md`): Butterfly depth and lateral edges (no pixel
  evidence — B4's job), GE E9 trapezoid depth (fit is ~30 px shallower than Andre — over-blank, one slider), a header
  text line directly above a sparse Butterfly near field (`bfly_z3` — the arc lands on the text; fail-open at the top,
  so the review UI matters there), the sector clips (n small), the three support failures (B6).

**2C inherits**
- Fingerprint inputs already computed by the proposer: the not-background mask and background mode (`background_stats`),
  the DICOM `(0018,6011)` box (`tier_t0`), frame dimensions.
- The Butterfly exports in the corpus are a worked example for B4: 632×1080 and 736×1080 frames, same geometry per
  depth setting; Andre's saved shapes for them are in `sandbox/bench/reviews.json`.
- B6's evaluation harness exists: `scripts/automask_spike/tune.py` scores any proposer variant against the 51 absolute
  references; T2ext (`bench.py --report`) is the max-projection code path to start from, re-targeted at the *support*.

---
> Draft only. The kickoff proper is written when 2A's runbook is green; §B goes into it unchanged.
