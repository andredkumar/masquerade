# Auto-mask — after the blocked-clip re-review: pass-3 amendment + 2B/2C product requirements

**Date:** 2026-09-06. **Input:** `sandbox/results/2026-09-06_0906_bench.md` (all 51 references valid; 31/51 tolerant with the pass-2 fits).

## A. Pass 3 amendment (add to `AUTOMASK_PASS3.md` §1 as **1e**, priority between 1a and 1b)

**1e. Mindray 079 curved fans (720×540, ×6) — apex/arc placement.** With the joint control usable, Andre's references now differ from the fit by apex 38–133 px, `r_in` −6…−121, depth −41…−139, half within ±2° except `clip06/07` (+5/+6°). `clip08` leaks 19 % (`leak_core6` 17 %). Only `clip05` passes. Sonosite curved (9 clips, 8 pass) is the regression guard — same model, different vendor; whatever fixes Mindray must leave Sonosite within 2 px on every parameter.
Diagnose first on the contact sheet: where is the fitted arc relative to the visible near field, and what sits above it (Mindray puts a probe-orientation glyph and a depth ruler near the arc). Likely the same isolated-blob-above-the-arc cause as Butterfly (1b) — so 1b's rule may cover both; test 1b before adding anything Mindray-specific. No per-vendor constants.
Split: `clip04/06/08` → tune, `clip07/09` → test (`clip05` already in tune).

Also: `ge_e9_6193094661` was not re-saved (still "wrong", shape 34–40 px outside the pixels); keep the "reference check" flag and exclude it from the freeze count until Andre confirms or redoes it. `sonosite_011_clip05` re-saved as "wrong" with IoU 0.984 / leak_core6 0.02 % — the prefilled note was carried over; treat the numbers, not the label.

Everything else in `AUTOMASK_PASS3.md` stands: last pass, freeze at whatever the numbers are, then 2A.

## B. Product requirements for 2B / 2C (from Andre's bench sessions — carry into the kickoffs verbatim)

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

**B6. Temporal support (2C candidate, after B4).** The three support failures (`bfly_z9`, `sonosite_011_clip10/11`) fail because frame 1 doesn't show the whole cone. A max projection over the clip as the *support* input (not as a depth extender — T2ext stayed at 60 % agreement) is the candidate; evaluate in the sandbox against the same references before it goes near the app.

---
> For Claude Code, appended to the pass-3 message: add §A (Mindray 079 curved fans, 1e; test 1b's blob rule on them first; Sonosite is the guard; `ge_e9_6193094661` excluded pending Andre; read `sonosite_011_clip05` by its numbers). Carry §B into the 2B/2C kickoff drafts unchanged.
