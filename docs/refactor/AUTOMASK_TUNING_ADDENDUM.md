# Auto-mask — tuning pass addendum (after Track 0 review 2026-09-05_1225)

**Inputs:** `sandbox/results/2026-09-05_1225_bench.md`, `sandbox/bench/reviews.json`, `CONSTANTS.md` (candidate). **Governs:** the "one Python tuning pass" in `AUTOMASK_2A_DECISIONS.md` §1b. **Round 2A remains blocked** until the re-review in §5 passes.

## 0. What the review said

15 positives reviewed: 0 right, 2 adjusted, 13 wrong. Every "wrong" note is the same sentence: *the two sides of the cone are at different angles.* Andre's standard, which is the physics: the fan is mirror-symmetric about the probe axis, and that axis is vertical on the display. This is not a constant to tune; the model is under-constrained.

Second finding: the bench's reference is depth-only, so `IoU fit vs user` is blind to angle and apex — the 8/15 tolerant count and every depth/T2ext number in this report are **confounded and are not to be used** for freezing anything.

Third: `kidney_copy` (GE Venue, positive) withheld by `masks_too_little`. Fourth: a non-corpus file (`phone_stairs`) was added as a negative — see §4.

## 1. Symmetric models (the change)

Replace the free-angle models with symmetric ones. Parameters and fitting:

**Fan** — `(ax, ay, half_angle, r_in, r_out)`, axis vertical through the apex. `th_l = −half_angle`, `th_r = +half_angle`. Fit: keep the hull → side-edge selection as is, then (a) estimate the apex as the intersection of the two independent side lines, (b) set `ax` to the *mean* x of the two sides' intersection with a horizontal line at the support's vertical centroid (i.e., the axis of symmetry of the visible sides, not the frame centre — GE places the image left of a panel), (c) `half_angle = mean(|th_l_free|, |th_r_free|)`, then (d) the existing coordinate-descent refinement over the **five** symmetric parameters only, with `ax` free to move ±2 % of width. Keep `refineFanRadii` for `r_out`.
Report `asym_deg = |th_l_free| − |th_r_free|` and `axis_tilt_deg` (angle of the free-fit bisector from vertical) in `components`. They are diagnostics: large values mean the support was poor (one side clipped by the frame edge, furniture merged), not that the cone is asymmetric.

**Trapezoid** (virtual convex / curvilinear far from apex) — `(cx, y_top, y_bottom, w_top, w_bottom)`, symmetric about `x = cx`. Fit: from the free quad, `cx` = mean of the four x-midpoints of top and bottom edges; widths from the free quad's top/bottom edge lengths; refine as above.

**Rectangle** — when the fitted trapezoid's implied side angle `< 3°` (existing `spread` rule) → `w_top = w_bottom`, model `rect`. `ge_e9_4515056095` (linear probe) must come out `rect` with `leak_core6` ≈ 0; today it leaks 9.8 %.

**Model selection** unchanged in spirit (fan preferred within `FAN_PREFERENCE`), now among `fan_sym | trap_sym | rect`. Drop the free models from the output entirely; keep them internal for the diagnostics.

**Clipped-side case:** when one side's hull edge lies on the frame border (the existing exclusion rule), fit the half-angle from the *other* side alone and mirror it. Do not average with a border segment.

**`bound` (T0):** still a hard clip on the rendered keep-region, never an input to the symmetric fit.

## 2. Bench: the reference must be able to express what Andre sees

Add to the review page, minimal and parametric (this is Track 0, not 2B):
- **Half-angle** slider (fan / trapezoid): both sides move together, apex fixed.
- **Apex nudge**: ← → ↑ ↓ buttons, 2 px steps (and a drag handle on the apex if cheap).
- **Top** (`r_in` / `y_top`) slider.
- Depth slider as today.
- The verdicts stay *Looks right / Adjusted / Wrong — needs redraw*, but **Adjusted** now means "I fixed it with the controls," and the saved reference is the full corrected parameter set, not just depth.
- Show the current parameters as numbers next to the controls (half-angle in degrees), so a note like "beam angle off" can become "26° → 31°".

`bench.py --report` then scores against the *fully corrected* shape: IoU, leak, over-blank, `_core6`, plus `Δ half_angle (deg)`, `Δ apex (px)`, `Δ top (px)`, `Δ depth (px)`. The tolerant-rule line becomes meaningful only from this version on; label the report `reference: full-parametric`.

`|Δu − Δt2|` (T2ext) stays, computed on depth only, but only for clips whose half-angle/apex delta is small (say `< 1°`, `< 4 px`) — otherwise it is confounded and printed as `—`.

## 3. `MIN_MASK_FRAC` miss

`kidney_copy` is a real clip withheld because < 5 % of the frame would be masked. Proposed rule to evaluate (state the one you pick and why): withhold on `masks_too_little` **only if** the interior gate is also borderline, or the support does not touch ≥ 2 frame edges; otherwise return a proposal with a `nothing_much_to_mask` flag. Lower `MIN_MASK_FRAC` to 0.02 at most. **Constraint:** `stock_demo_480p` and the replacement negative (§4) must still withhold, and the report must show which gate caught each negative after the change. If they cannot be separated, keep 0.05 and log `kidney_copy` as a known miss with its components — do not weaken the negatives to pass one clip.

## 4. Corpus hygiene — a hard rule

`phone_stairs` is a personal photo from Andre's machine, not something he supplied. Remove it from `sandbox/clips/`, `manifest.csv`, `sandbox/bench/` (page, `_frames/` cache, `reviews.json` entry). **Rule from here on:** nothing enters `sandbox/clips/` unless Andre put it there. The agent never browses, copies, or references files outside the repo and `sandbox/`. Negatives are Andre's to supply; if he has not, generate a *synthetic* negative (a rendered slide with text on a white background, a random-noise image) and label it as such in the manifest. Confirm in the report that the file and its derivatives are gone.

Also: `bfly_frame_000089/92` and `sector_unknown_vendor` have empty `vendor` cells — leave them for Andre to fill; do not guess from headers.

## 5. Procedure and exit

1. Implement §1 and §2. Regenerate all 29 (`bench.py --rebuild`). Any clip whose *rendered* proposal is unchanged by the symmetric fit (they should all change at least slightly): say so.
2. Report per clip, before → after: model, `half_angle` (free-L / free-R → symmetric), `asym_deg`, `axis_tilt_deg`, conf. Plus a contact sheet of the 15 reviewed clips, old outline vs new outline on frame 1, so Andre can see the difference before re-reviewing.
3. `CONSTANTS.md`: add the symmetric-model rows; **still CANDIDATE.**
4. Andre re-reviews with the new controls (all 29, including the 11 not yet reviewed). `bench.py --report` → `full-parametric` table.
5. **Freeze condition (unchanged from D5, now meaningful):** ≥ 5/7 kickoff clips and ≥ 70 % of all positives meet the tolerant rule (IoU ≥ 0.90, `leak_core6` ≤ 1 %) with the *fitted* parameters; report the count after Andre's adjustments separately. Negatives all withheld. Then freeze `CONSTANTS.md` and open 2A.
6. If the re-review still fails on angle: stop, report the `asym_deg`/`axis_tilt_deg` distribution and three worst contact sheets, and we look at the support step (density / opening) rather than the fit.

Rules: one pass, per-clip before/after, no clip that passed may fall (there are none that count yet — this is the first real baseline). `tsc` untouched (no app code in this pass).

---

## Message for the Claude Code session

> Read `AUTOMASK_TUNING_ADDENDUM.md`. Andre's first Track 0 review: 13/15 wrong, all for the same reason — the two cone sides are fit at different angles, and the physics says they are equal about a vertical axis through the apex. Replace the free fan/quad with **symmetric** fan / symmetric trapezoid / rectangle (§1), add half-angle, apex, and top controls to the bench so the reference is full-parametric (§2), fix the `kidney_copy` withhold without weakening negatives (§3), and **remove `phone_stairs`** — a personal file that must never have been added; from now on nothing enters `sandbox/clips/` unless Andre put it there (§4). Rebuild all 29, report before → after per clip with a contact sheet of the 15 reviewed clips, keep `CONSTANTS.md` as CANDIDATE, and stop for Andre's re-review. No 2A code.
