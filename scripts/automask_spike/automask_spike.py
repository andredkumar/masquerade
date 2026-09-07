#!/usr/bin/env python3
"""
Auto-mask Round 1 — offline spike (THROWAWAY, not shipped).

For each clip in the test set:
  * T0  (DICOM only)  : SequenceOfUltrasoundRegions (0018,6011) -> rectangle keep-region.
  * T1  (frame 1 only): background level (histogram mode) -> not-background -> local density -> open/close ->
                        largest component (or a fan-shaped union of large components) -> SYMMETRIC model
                        selection (fan_sym | trap_sym | rect, tuning pass 1) -> far-field completion (fan) ->
                        2-px fail-closed erosion. Free fan/quad fits survive only as diagnostics.
  * T0T1 (DICOM)      : T1 run with everything outside the T0 box zeroed first (T0 as a hard bound).
  * T2  (N frames)    : per-pixel temporal std/mean at 4x downscale -> static-overlay map
                        (bright & unchanging) subtracted from the T1 support before the fit.
  * T2max (variant)   : as T2, but the support comes from the temporal MAX projection
                        rather than frame 1 (fills a dark far field). Reported separately;
                        the pre-committed T2 verdict is on T2 as specified in the kickoff.

Outputs, per clip, under out/<clip>/:
  t1_keep.png, t2_static.png, t2_keep.png, t2max_keep.png, t0_keep.png (if DICOM),
  ref_keep.png, contact.png  (frame 1 with every keep-region outlined),
and out/results.json + out/results.md (clip x tier -> IoU / leak / over-blank / ms).

Scoring is against a REFERENCE keep-region from refs.json (see that file's header
for how each reference was authored — they are NOT Andre's masks).

Usage:
  python3 automask_spike.py --frames <root with <clip>/frame_%06d.png> --out out/ [--clips a,b]
  python3 automask_spike.py ... --dump-candidates   # write T1/T2max fan params for ref authoring
"""
from __future__ import annotations
import argparse, json, math, os, sys, time, glob
import numpy as np
import cv2

cv2.setNumThreads(1)  # prod is one physical core; measure like it

DOWN = 4          # analysis downscale (kickoff §6: 4x)
T_LOW = 3         # 0-255 gray threshold for "not black" (background is pure black on every clip measured)
K_DENS = 11       # density window (px at analysis scale): fraction of not-black pixels
D_MIN = 0.35      # density above which a pixel belongs to image content (text lines score <= 0.27)
K_OPEN = 5        # px at analysis scale (=20 px full-res): cleans the density mask
K_CLOSE_SMALL = 7 # px at analysis scale (=28 px full-res): joins near neighbours BEFORE picking the largest component
K_CLOSE = 15      # px at analysis scale (=60 px full-res): bridges anechoic gaps inside the chosen component
# Pass 2 rules (AUTOMASK_PASS2_REVISED.md §2), each switchable so the tuning harness can attribute changes.
RULES = {
    'top60':       True,   # rect/trap top edge = first row >= TOP_WIDE_FRAC of the widest row, sustained TOP_SUSTAIN rows; rows above are dropped from the support
    'rin_coverage': True,  # fan r_in = radius where angular coverage of the wedge first reaches RIN_COVERAGE (sustained), not the 0.3 percentile
    'fan_axis_mid': True,  # fan axis x = median midpoint of the clean near-field rows below the arc (both edges inside the
                           # frame, no jump); the hull-side intersection puts the apex 16–25 px off-centre on wide Butterfly
                           # fans whose far-field sides are frame-clipped, lost (echo-free) or merged with the depth ruler
    'fan_reseed_above_arc': True, # PASS 3 §1e: once the arc rule has placed r_in, everything above the arc (header text bridged in
                           # by the density filter) is cropped from the support and the fan is seeded AGAIN on what is left. The
                           # hull side edges had been running from the far field up to the frame top THROUGH the header text
                           # (Mindray 079: sides 24° instead of 30°, apex 124 px too high, the fan too wide at the top)
    'band_consistency': False,# PASS 3 §1c — EVALUATED, NOT ADOPTED: violated the guard (passing GE traps moved up to 63 px, two fell): per-side Theil–Sen on the clean band, rows whose edge residual exceeds SIDE_RESID_PX
                           # dropped, one refit; if the two sides' half-widths at y_top then disagree by > 10 %, the NARROWER side
                           # is the truth and is mirrored (a merged structure only ever makes a side wider)
    'drop_small_blobs': True,# PASS 3 §1b (generalised): components of the density mask smaller than BLOB_FRAC of the largest are
                           # dropped BEFORE the closing step, and their pixels are removed from the not-background mask the
                           # r_in / top rules read. The closing (K_CLOSE 15) had been bridging the Butterfly header text and
                           # the Mindray "m" glyph / depth ruler into the support; separate components never touch by
                           # construction, so "isolated" is the component test itself
    'fan_wider_side': False,# EVALUATED, NOT ADOPTED: wider-side seed dropped mindray_079_clip05 1.000→0.935 and 4 more tune fans
    't0_depth_rect': True, # rect on a T0 clip: depth = region-box bottom (hypothesis held 2/2 rects, 0/16 trapezoids → rect only)
    'conf_bbox':   True,   # outside_blob_frac counts only blobs intersecting the shape's (5 %-expanded) bounding box
}
TOP_WIDE_FRAC = 0.60  # was 0.30
TOP_SUSTAIN = 8       # rows (4x). PASS 2: 3 → 8. GE Venue puts two header lines (patient / date, PHI!) directly above
                      # the image: each is 4 rows tall at 4x, ≥ 60 % as wide as the image and dense, with 1–2 empty rows
                      # between — a 3-row sustain accepted them and the top landed on the PHI. Text lines are ≤ 6 rows at
                      # any width in the corpus (≤ 24 px full); an image top holds for hundreds.
TRAP_DEPTH = 'refine' # 'refine': after the band fit, y_bottom alone is refined on the FULL support with the side lines
                      # fixed (the pass-1 depth objective, cover − 0.5·extra — depth is not tuned by a new rule, §2);
                      # 'deepest': y_bottom = deepest support row (pass 2, evaluated only);
                      # 'image_rows': PASS 3 §1a as specified — the top rule mirrored, walking UP from the deepest support
                      #   row: a row is the image when its support extent is ≥ TOP_WIDE_FRAC of the widest row AND its
                      #   not-background fill ≥ TOP_FILL_MIN, sustained TOP_SUSTAIN rows; y_bottom = deepest such row;
                      # 'profile': PASS 3 variant — refine_fan_radii's walk for the trapezoid: from the band end go down
                      #   while the not-background fraction between the fitted side lines stays > R_PROFILE_MIN, stop
                      #   at the first gap of 3 rows
AXIS_MID_MIN_SHIFT = 4 # (4x px) the midpoint axis replaces the hull-intersection axis only when they disagree by more
                      # than this (16 px full). On every clean fan in the tune half the two agree within 3.4 px; the
                      # wide Butterfly fans disagree by 6–8.5 px. Below the threshold the pass-1 fit is left bit-identical
                      # — the curved Sonosite/Mindray fans are the regression guard and the rule must not touch them.
RESEED_MIN_FRAC = 0.005 # fan_reseed_above_arc: re-seed only if the crop above the arc removed more than this fraction of the support
SIDE_RESID_PX = 2     # (4× px = 8 px full; the pass-3 doc says 6 px) band_consistency: edge residual beyond this drops the row
SIDE_MIRROR_FRAC = 0.10 # band_consistency: sides disagree by more than this at y_top → mirror the narrower one
TOP_FILL_SRC = 'raw'  # 'raw' = not-background mask (adopted); 'density' = the K_DENS density region (§1d, evaluated)
BLOB_FRAC = 0.02      # drop_small_blobs: density components below this fraction of the largest are furniture, not image
SIDE_JUMP_PX = 4      # rows whose support edge moves > this (4x px) from the previous row end the CLEAN side band
                      # (a straight side moves ≤ 1 px/row; a merge with the greyscale bar or a lost corner jumps)
TOP_FILL_MIN = 0.50   # a row / radial bin is INSIDE the image when at least this fraction of it is not-background
                      # (the density support is dilated ~half a window past the true edge and keeps full-width header
                      # text; the raw not-background mask sees both: the near-field is dense, text and dilation are sparse)
RIN_COVERAGE = 0.80   # fraction of the wedge's angular bins that must contain support at a radius for it to count as inside the cone
RIN_SUSTAIN = 3       # radial bins (2 px at the analysis scale)
FAN_PREFERENCE = 0.03 # the preferred family must be beaten by more than this fit score for the other to be chosen
TOP_FLAT_FRAC = 0.50  # if the support's top edge spans >= this fraction of the frame width, the near field is a straight
                      # edge (virtual convex / linear): prefer the trapezoid family; otherwise (arc / apex) prefer the fan
EXTRA_PENALTY = 0.5   # fit objective = cover − EXTRA_PENALTY·extra: the visible support is a SUBSET of the true cone
                      # (echo-free corners, dim far field), so missing support is expensive and extra area is cheap
UNION_COVER = 0.95    # a fan fitted to the union must cover this much of it
UNION_MAX_RATIO = 4.0 # ...and be at most this many times its area (the echo-free band is the difference)
UNION_FRAC = 0.10     # components at least this fraction of the largest may be unioned into one cone
R_PROFILE_MIN = 0.15  # pass 3 §1d: 0.12 → 0.15; no tune-half fan moved under it (identical fits), aimed at the 24 px far-field overrun on sonosite_011_clip08  # radial-profile continuity gate for far-field completion inside a fitted fan's wedge
K_CUT = 9         # px at analysis scale: cuts thin bridges to side furniture (e.g. GE grayscale bar)
T_BRIGHT = 18     # used only for the outside-blob confidence term
T2_N = 20         # frames sampled for T2
T2_STD = 6.0      # temporal std below which a pixel is "static"
T2_MEAN = 60.0    # temporal mean above which a static pixel is "bright overlay"
MARGIN_PX = 2     # full-res inward safety margin on the keep-region (fail-closed)
MIN_MASK_FRAC = 0.05  # proposal must blank at least this much of the frame or it is withheld (see confidence())
# Background model (tuning pass 1): the "black" level is the histogram MODE of the 4x gray, not 0 — full-screen
# captures (GE Venue) sit on a flat dark-gray UI (mode 22). not-background = gray > mode + T_LOW.
BG_TOL = 3            # ± window around the mode that counts as background
BG_MIN_FRAC = 0.10    # an ultrasound export has a flat background covering at least this much of the frame
BG_MAX_LEVEL = 48     # ... and that background is dark; a white slide / photo mode above this is withheld

# ----------------------------------------------------------------------------- utilities

def imread_gray_rgb(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise FileNotFoundError(path)
    if im.ndim == 2:
        gray = im
        rgb = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    else:
        if im.shape[2] == 4:
            im = im[:, :, :3]
        rgb = im
        gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    return gray, rgb


def small(img):
    h, w = img.shape[:2]
    return cv2.resize(img, (w // DOWN, h // DOWN), interpolation=cv2.INTER_AREA)


def fill_holes(mask_u8):
    """Fill enclosed holes: flood the background from the border, invert."""
    h, w = mask_u8.shape
    ff = np.zeros((h + 2, w + 2), np.uint8)
    inv = (mask_u8 == 0).astype(np.uint8)
    # flood from every border pixel that is background
    flooded = inv.copy()
    cv2.floodFill(flooded, ff, (0, 0), 2)
    for x in range(0, w, max(1, w // 32)):
        for y in (0, h - 1):
            if flooded[y, x] == 1:
                cv2.floodFill(flooded, ff, (x, y), 2)
    for y in range(0, h, max(1, h // 32)):
        for x in (0, w - 1):
            if flooded[y, x] == 1:
                cv2.floodFill(flooded, ff, (x, y), 2)
    holes = (flooded == 1)
    out = mask_u8.copy()
    out[holes] = 1
    return out


def largest_component(mask_u8):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    if n <= 1:
        return np.zeros_like(mask_u8), 0
    idx = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    return (lab == idx).astype(np.uint8), int(stats[idx, cv2.CC_STAT_AREA])


def background_stats(gray_s):
    """(mode, fraction of pixels within ±BG_TOL of the mode) on the analysis grid."""
    hist = np.bincount(gray_s.ravel(), minlength=256)
    mode = int(hist.argmax())
    frac = float(hist[max(0, mode - BG_TOL):mode + BG_TOL + 1].sum() / gray_s.size)
    return mode, frac


def clean_support(gray_s, remove=None, bg=0):
    """not-background -> (subtract overlay) -> local density -> open -> small close -> largest CC ->
    big close (on that component only, so side furniture can never be bridged in) -> fill -> cut bridges."""
    notblack = (gray_s > bg + T_LOW).astype(np.uint8)
    if remove is not None:
        notblack[remove > 0] = 0
    dens = cv2.boxFilter(notblack.astype(np.float32), -1, (K_DENS, K_DENS), normalize=True)
    region = (dens > D_MIN).astype(np.uint8); clean_support.last_region = region
    ko = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (K_OPEN, K_OPEN))
    ks = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (K_CLOSE_SMALL, K_CLOSE_SMALL))
    kc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (K_CLOSE, K_CLOSE))
    kx = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (K_CUT, K_CUT))
    opened = cv2.morphologyEx(region, cv2.MORPH_OPEN, ko)
    removed = np.zeros_like(opened); clean_support.last_blobs = []
    if RULES.get('drop_small_blobs'):
        n_, lab_, st_, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
        if n_ > 2:
            areas_ = st_[1:, cv2.CC_STAT_AREA]; small_ = [i + 1 for i, a_ in enumerate(areas_) if a_ < BLOB_FRAC * areas_.max()]
            if small_:
                removed = np.isin(lab_, small_).astype(np.uint8)
                opened = opened.copy(); opened[removed > 0] = 0
                clean_support.last_blobs = [tuple(int(v) for v in (st_[i, cv2.CC_STAT_AREA], st_[i, cv2.CC_STAT_LEFT], st_[i, cv2.CC_STAT_TOP], st_[i, cv2.CC_STAT_WIDTH], st_[i, cv2.CC_STAT_HEIGHT])) for i in small_]
    clean_support.last_removed = cv2.dilate(removed, ks) if removed.any() else removed
    clean_support.last_opened = opened
    closed_s = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, ks)
    comp, _ = largest_component(closed_s)
    comp = fill_holes(cv2.morphologyEx(comp, cv2.MORPH_CLOSE, kc))
    comp = cv2.morphologyEx(comp, cv2.MORPH_OPEN, kx)   # drop appendages
    comp, area = largest_component(comp)
    comp = fill_holes(comp)
    # alternative support: union of every component at least UNION_FRAC of the largest (a cone split by an
    # echo-free band). Only used if the union itself fits a fan well — see fit_support().
    n, lab, stats, _ = cv2.connectedComponentsWithStats(closed_s, connectivity=8)
    union = None
    if n > 2:
        areas = stats[1:, cv2.CC_STAT_AREA]; big = [i + 1 for i, a in enumerate(areas) if a >= UNION_FRAC * areas.max()]
        if len(big) > 1:
            union = np.isin(lab, big).astype(np.uint8)
            union = fill_holes(cv2.morphologyEx(union, cv2.MORPH_CLOSE, kc))
    clean_support.last_union = union
    bright = (gray_s > bg + T_BRIGHT).astype(np.uint8)
    if remove is not None:
        bright[remove > 0] = 0
    blobs = cv2.morphologyEx(bright, cv2.MORPH_OPEN, ko)
    return comp, blobs, area


def refine_fan_radii(p, gray_s, remove=None, bg=0):
    """Far-field completion for the fan model only. Walk outward from r_out (and inward from r_in) in 2-px
    radial bins; each bin's value is the fraction of not-black pixels across the wedge's whole angular span.
    Extend while the profile stays above R_PROFILE_MIN; stop at the first gap. A depth scale or text that
    happens to sit inside the wedge occupies a tiny slice of each bin, so it cannot carry the profile."""
    h, w = gray_s.shape
    notblack = (gray_s > bg + T_LOW)
    if remove is not None:
        notblack = notblack & (remove == 0)
    ys, xs = np.mgrid[0:h, 0:w]
    dx = xs - p['ax']; dy = ys - p['ay']
    th = np.arctan2(dx, dy); r = np.hypot(dx, dy)
    pad = 0.15 * (p['th_r'] - p['th_l'])
    inwedge = (th > p['th_l'] + pad) & (th < p['th_r'] - pad)
    rb = (r[inwedge] / 2).astype(np.int32); nb = notblack[inwedge]
    nbins = int(rb.max()) + 2
    tot = np.bincount(rb, minlength=nbins).astype(np.float32)
    hit = np.bincount(rb, weights=nb.astype(np.float32), minlength=nbins)
    prof = np.where(tot > 0, hit / np.maximum(tot, 1), 0.0)
    q = dict(p); info = {'radii_refined': True}
    b = int(p['r_out'] / 2)
    while b + 1 < nbins and prof[b + 1] > R_PROFILE_MIN:
        b += 1
    q['r_out'] = max(p['r_out'], (b + 1) * 2.0)
    b = int(p['r_in'] / 2)
    while b - 1 >= 0 and prof[b - 1] > R_PROFILE_MIN:
        b -= 1
    q['r_in'] = min(p['r_in'], max(0.0, b * 2.0))
    info['r_out_delta'] = round(q['r_out'] - p['r_out'], 1); info['r_in_delta'] = round(q['r_in'] - p['r_in'], 1)
    return q, info

# ----------------------------------------------------------------------------- fan model

def render_fan(shape, p):
    """p = dict(kind='fan'|'trap'|'rect'|'poly', ...) at the given (h, w). Returns uint8 mask."""
    h, w = shape
    if p['kind'] in ('trap', 'rect') and 'cx' in p:
        return render_trap(shape, p)
    if p['kind'] == 'rect':
        m = np.zeros((h, w), np.uint8)
        x0, y0, x1, y1 = [int(round(v)) for v in (p['x0'], p['y0'], p['x1'], p['y1'])]
        m[max(0, y0):min(h, y1 + 1), max(0, x0):min(w, x1 + 1)] = 1
        return m
    if p['kind'] == 'poly':
        m = np.zeros((h, w), np.uint8)
        pts = np.array(p['pts'], np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(m, [pts], 1)
        return m
    ys, xs = np.mgrid[0:h, 0:w]
    dx = xs - p['ax']
    dy = ys - p['ay']
    r = np.hypot(dx, dy)
    th = np.arctan2(dx, dy)  # 0 = straight down, + to the right
    m = (r >= p['r_in']) & (r <= p['r_out']) & (th >= p['th_l']) & (th <= p['th_r'])
    return m.astype(np.uint8)


def iou(a, b):
    a = a > 0; b = b > 0
    u = np.count_nonzero(a | b)
    return (np.count_nonzero(a & b) / u) if u else 0.0


def fit_score(shape_mask, support):
    """cover − EXTRA_PENALTY·extra (tuning pass 1). IoU shrank symmetric shapes to split the difference over an
    echo-free corner; this objective asks the shape to cover everything visible and tolerates extra area."""
    S = support > 0; F = shape_mask > 0
    inter = np.count_nonzero(S & F)
    cover = inter / max(1, np.count_nonzero(S))
    extra = (np.count_nonzero(F) - inter) / max(1, np.count_nonzero(F))
    return cover - EXTRA_PENALTY * extra


def hull_side_edges(support):
    """Simplified convex hull → candidate side edges (non-horizontal, not on the frame border), split into
    left/right of the support's x-centroid. Returns (edges_left, edges_right, hull_poly, ys, xs)."""
    ys, xs = np.nonzero(support)
    pts = np.stack([xs, ys], 1).astype(np.int32)
    hull = cv2.convexHull(pts)
    poly = cv2.approxPolyDP(hull, 0.006 * cv2.arcLength(hull, True), True).reshape(-1, 2).astype(np.float64)
    W, H = support.shape[1] - 1, support.shape[0] - 1
    edges = []
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        d = b - a; L = np.hypot(*d)
        if L < 1e-6 or abs(d[1]) < 0.35 * abs(d[0]):          # near-horizontal: arc chord / flat edge
            continue
        if (a[0] <= 1 and b[0] <= 1) or (a[0] >= W - 1 and b[0] >= W - 1) or (a[1] <= 1 and b[1] <= 1) or (a[1] >= H - 1 and b[1] >= H - 1):
            continue                                            # frame border clipping the cone, not a side
        edges.append((L, a, b))
    edges.sort(key=lambda e: -e[0])
    cx = xs.mean()
    left = [e for e in edges if (e[1][0] + e[2][0]) / 2 < cx]
    right = [e for e in edges if (e[1][0] + e[2][0]) / 2 >= cx]
    return left, right, poly, ys, xs


def _slope(a, b):  # dx/dy of a segment (both sides are non-horizontal by construction)
    return (b[0] - a[0]) / (b[1] - a[1])


def _x_at(a, sl, y):  # x on the line through a with slope dx/dy = sl, at height y
    return a[0] + sl * (y - a[1])


def fit_quad(support):
    """FREE quad (diagnostic only since the symmetric models): convex hull simplified to a few straight edges."""
    ys, xs = np.nonzero(support)
    pts = np.stack([xs, ys], 1).astype(np.int32)
    hull = cv2.convexHull(pts)
    per = cv2.arcLength(hull, True)
    poly = cv2.approxPolyDP(hull, 0.012 * per, True).reshape(-1, 2)
    return {'kind': 'poly', 'pts': poly.tolist()}, {'n_vertices': int(len(poly))}


def fit_fan_sym(support, notblack=None, _reseed=0):
    """SYMMETRIC fan (ax, ay, half_angle, r_in, r_out), axis vertical through the apex (tuning addendum §1).
    Free side lines are fitted as before and kept as diagnostics; the model itself is mirror-symmetric:
      apex y from the free-line intersection; axis x = mean of the two sides' x at the support's vertical
      centroid; half_angle = mean(|θ_l|, |θ_r|); then coordinate descent over the five symmetric parameters
      (ax limited to ±2 % of the width). One side on the frame border → the other side is mirrored."""
    ys, xs = np.nonzero(support)
    if len(ys) < 50:
        return None, {'reason': 'support_too_small'}
    h, w = support.shape
    y_min, y_max = ys.min(), ys.max(); yc = ys.mean()
    left, right, poly, _, _ = hull_side_edges(support)
    if not left and not right:
        return None, {'reason': 'no_side_edges'}
    info = {}
    if left and right:
        (_, a1, b1), (_, a2, b2) = left[0], right[0]
        sL, sR = _slope(a1, b1), _slope(a2, b2)
        thL, thR = math.atan(sL), math.atan(sR)                 # from vertical; left should be < 0, right > 0
        info.update(th_l_free_deg=round(math.degrees(thL), 2), th_r_free_deg=round(math.degrees(thR), 2),
                    asym_deg=round(math.degrees(abs(thL) - abs(thR)), 2), axis_tilt_deg=round(math.degrees((thL + thR) / 2), 2),
                    side_spread_deg=round(math.degrees(abs(thR - thL)), 2), clipped_side=None)
        if abs(sL - sR) < 1e-9 or abs(thR - thL) < math.radians(3.0):
            return None, {**info, 'reason': 'sides_parallel'}
        xL0 = a1[0] - sL * a1[1]; xR0 = a2[0] - sR * a2[1]
        ay = (xR0 - xL0) / (sL - sR)                             # free-line intersection height
        ax = 0.5 * (_x_at(a1, sL, yc) + _x_at(a2, sR, yc))      # axis of symmetry of the visible sides
        half = max(abs(thL), abs(thR)) if RULES['fan_wider_side'] else 0.5 * (abs(thL) + abs(thR))
    else:
        # one side clipped by the frame: mirror the visible side about the axis given by the top rows' midpoint
        (_, a, b) = (left or right)[0]
        sl = _slope(a, b); th = math.atan(sl)
        top_rows = ys <= y_min + max(2, 0.10 * (y_max - y_min))
        ax = 0.5 * (xs[top_rows].min() + xs[top_rows].max())
        half = abs(th)
        if half < math.radians(1.5):
            return None, {'reason': 'sides_parallel', 'clipped_side': 'left' if right else 'right'}
        ay = a[1] - (a[0] - ax) / math.tan(th) if abs(math.tan(th)) > 1e-9 else y_min - 1e6
        info.update(th_l_free_deg=None, th_r_free_deg=None, asym_deg=None, axis_tilt_deg=None,
                    side_spread_deg=round(math.degrees(2 * half), 2), clipped_side='left' if right else 'right')
    if ay > y_min + 0.25 * (y_max - y_min):
        return None, {**info, 'reason': 'apex_not_above'}
    dx = xs - ax; dy = ys - ay
    r = np.hypot(dx, dy)
    r_in = float(np.percentile(r, 0.3))
    ax_frozen = False
    if RULES['fan_axis_mid'] and left and right:
        # PASS 2 — the axis from the rows just below the arc, where both sides are sharp and inside the frame. Walk
        # down from the arc for a quarter of the depth; stop at the first row whose edge is on the frame border or
        # jumps > SIDE_JUMP_PX (a lost corner, a merged ruler). Median midpoint = the axis; the refinement then keeps it.
        r_out0 = float(np.percentile(r, 99.7))
        y0 = int(ay + r_in) + 2; y1 = int(min(h - 1, y0 + 0.25 * (r_out0 - r_in)))
        mids = []; prev = None
        for y in range(max(0, y0), y1 + 1):
            row = np.nonzero(support[y])[0]
            if len(row) == 0: continue
            xl, xr = row[0], row[-1]
            if xl <= 1 or xr >= w - 2: break
            if prev is not None and (abs(xl - prev[0]) > SIDE_JUMP_PX or abs(xr - prev[1]) > SIDE_JUMP_PX): break
            mids.append(0.5 * (xl + xr)); prev = (xl, xr)
        info['axis_mid_rows'] = len(mids)
        if len(mids) >= 6:
            ax_mid = float(np.median(mids)); info['axis_mid_shift'] = round(ax_mid - ax, 2)
            if abs(ax_mid - ax) > AXIS_MID_MIN_SHIFT:
                ax = ax_mid; ax_frozen = True
                dx = xs - ax; r = np.hypot(dx, dy)
    if RULES['rin_coverage']:
        # r_in = the radius at which the support's angular coverage of the wedge first reaches RIN_COVERAGE for
        # RIN_SUSTAIN bins. An orientation marker or label above the arc covers a sliver of the wedge only, so
        # it cannot pull the arc up; those pixels are then dropped from the support for the refinement.
        # (radius, angle) bins over the whole wedge on the RAW not-background mask: a bin counts when >= TOP_FILL_MIN
        # of its pixels are not-background; the radius where >= RIN_COVERAGE of the angular bins count, sustained, is r_in
        H, W = support.shape
        YY, XX = np.mgrid[0:H, 0:W]
        TH = np.arctan2(XX - ax, YY - ay); RR = np.hypot(XX - ax, YY - ay)
        inw = (np.abs(TH) <= half) & (RR <= np.percentile(r, 99.7))
        src = (notblack > 0) if notblack is not None else (support > 0)
        rb = (RR[inw] / 2).astype(int); ab = ((TH[inw] + half) / (2 * half) * 23.999).astype(int)
        nb = int(rb.max()) + 1 if len(rb) else 0
        cov = np.zeros(nb)
        if nb:
            tot = np.zeros((nb, 24)); hit = np.zeros((nb, 24))
            np.add.at(tot, (rb, ab), 1); np.add.at(hit, (rb, ab), src[inw].astype(float))
            frac = np.where(tot > 0, hit / np.maximum(tot, 1), 0.0)
            cov = (frac >= TOP_FILL_MIN).sum(1) / 24.0
            run = np.convolve((cov >= RIN_COVERAGE).astype(int), np.ones(RIN_SUSTAIN, int), 'valid')
            first = np.nonzero(run >= RIN_SUSTAIN)[0]
            if len(first):
                r_in = float(first[0] * 2)
                info['rin_rule'] = 'coverage'
        if RULES.get('fan_reseed_above_arc') and _reseed == 0 and 'rin_rule' in info:
            above = r < r_in - 1
            if above.sum() > RESEED_MIN_FRAC * len(r) and (~above).sum() > 50:
                sup2 = support.copy(); sup2[ys[above], xs[above]] = 0
                nb2 = None
                if notblack is not None:
                    nb2 = notblack.copy(); nb2[RR < r_in - 1] = 0
                p2, info2 = fit_fan_sym(sup2, nb2, _reseed=1)
                if p2 is not None:
                    info2['reseeded'] = 'above_arc'; info2['reseed_removed_px'] = int(above.sum()); info2['first_pass'] = {'ax': round(ax, 1), 'ay': round(ay, 1), 'half_deg': round(math.degrees(half), 2), 'r_in': r_in}
                    return p2, info2
        if 'rin_rule' in info:
            keep_px = r >= r_in - 1
            if keep_px.sum() > 50:
                support = support.copy(); support[ys[~keep_px], xs[~keep_px]] = 0
                ys, xs = ys[keep_px], xs[keep_px]; r = r[keep_px]
    p = {'kind': 'fan', 'sym': True, 'ax': float(ax), 'ay': float(ay), 'half_angle': float(half),
         'r_in': r_in, 'r_out': float(np.percentile(r, 99.7))}
    p['th_l'], p['th_r'] = -p['half_angle'], p['half_angle']
    best = fit_score(render_fan(support.shape, p), support)
    ro = p['r_out']; ax0 = p['ax']; ax_lim = 0.02 * w
    steps = {'ax': 0.005 * w, 'ay': 0.02 * ro, 'half_angle': 0.01, 'r_in': 0.01 * ro, 'r_out': 0.01 * ro}
    if ax_frozen: steps.pop('ax'); info['axis'] = 'midpoints'
    for _ in range(5):
        improved = False
        for k, st in steps.items():
            for sgn in (-1, 1):
                q = dict(p); q[k] = p[k] + sgn * st
                if k == 'ax' and abs(q['ax'] - ax0) > ax_lim: continue
                if q['r_in'] < 0 or q['r_out'] <= q['r_in'] or q['half_angle'] <= math.radians(1) or q['half_angle'] >= math.radians(85): continue
                q['th_l'], q['th_r'] = -q['half_angle'], q['half_angle']
                v = fit_score(render_fan(support.shape, q), support)
                if v > best + 1e-4:
                    best, p, improved = v, q, True
        if not improved:
            steps = {k: v / 2 for k, v in steps.items()}
    info['fan_sym_score'] = round(best, 4); info['fan_sym_iou'] = round(iou(render_fan(support.shape, p), support), 4)
    info['half_angle_deg'] = round(math.degrees(p['half_angle']), 2)
    return p, info


def render_trap(shape, p):
    """Symmetric trapezoid / rectangle: (cx, y_top, y_bottom, w_top, w_bottom) about x = cx."""
    h, w = shape
    m = np.zeros((h, w), np.uint8)
    pts = np.array([[p['cx'] - p['w_top'] / 2, p['y_top']], [p['cx'] + p['w_top'] / 2, p['y_top']],
                    [p['cx'] + p['w_bottom'] / 2, p['y_bottom']], [p['cx'] - p['w_bottom'] / 2, p['y_bottom']]], np.float64)
    cv2.fillPoly(m, [np.round(pts).astype(np.int32).reshape(-1, 1, 2)], 1)
    return m


def trap_side_angle_deg(p):
    return math.degrees(math.atan2((p['w_bottom'] - p['w_top']) / 2, max(1e-6, p['y_bottom'] - p['y_top'])))


def fit_trap_sym(support, notblack=None, xlim=None):
    """SYMMETRIC trapezoid (cx, y_top, y_bottom, w_top, w_bottom) — virtual convex / linear far from the apex.
    Seed (tuning pass 1, deviates from the addendum's quad-midpoint seed for a reason): GE frames lose their
    echo-free bottom corners, so anything derived from the quad's bottom edge is biased. Instead:
      • cx and w_top from the TOP edge (bright near field, always present);
      • the side angle from the per-row half-width taken as the WIDER of the two sides about cx (symmetry means
        the wider side is the true one; a missing corner only ever makes a side look narrower), rows where the
        wider side is clipped by the frame border excluded, Theil–Sen slope;
      • y_bottom = the deepest support row.
    Refined by coordinate descent on fit_score. Implied side angle < 3° → rectangle (w_top = w_bottom)."""
    h, w = support.shape
    ys, xs = np.nonzero(support)
    if len(ys) < 50:
        return None, {'reason': 'support_too_small'}
    y_top, y_bottom = int(ys.min()), int(ys.max())
    # the TOP EDGE is where the support becomes wide: skip thin rows above it (a vendor label merged into the
    # support by the closing step would otherwise define cx and w_top — GE puts "LOGIQ E9" 20 px above the image)
    ext = np.array([(np.nonzero(support[y])[0][[0, -1]] if support[y].any() else (0, -1)) for y in range(y_top, y_bottom + 1)])
    widths = ext[:, 1] - ext[:, 0] + 1
    if RULES['top60']:
        # first row that is >= TOP_WIDE_FRAC of the widest row, whose not-background FILL over the support span is
        # >= TOP_FILL_MIN, sustained TOP_SUSTAIN rows. Header text (sparse strokes) and the density mask's own
        # dilation above the true edge both fail the fill test; rows above are dropped from the support so the
        # refinement cannot pull the top back up.
        ok = widths >= TOP_WIDE_FRAC * widths.max()
        if notblack is not None:
            fill = np.array([notblack[y_top + i, e[0]:e[1] + 1].mean() if e[1] >= e[0] else 0.0 for i, e in enumerate(ext)])
            ok &= fill >= TOP_FILL_MIN
        run = np.convolve(ok.astype(int), np.ones(TOP_SUSTAIN, int), 'valid')
        wide = np.nonzero(run >= TOP_SUSTAIN)[0]
        if len(wide):
            y_top = y_top + int(wide[0])
            support = support.copy(); support[:y_top] = 0
            ys, xs = np.nonzero(support)
    else:
        wide = np.nonzero(widths >= 0.30 * widths.max())[0]
        y_top = y_top + int(wide[0]) if len(wide) else y_top
    band = (ys >= y_top) & (ys <= y_top + max(2, int(0.03 * (y_bottom - y_top))))
    x_l, x_r = xs[band].min(), xs[band].max()
    cx = 0.5 * (x_l + x_r); w_top_meas = float(x_r - x_l)
    x0, x1 = (0, w - 1) if xlim is None else xlim
    # PASS 2 — sides from the CLEAN NEAR-FIELD BAND. Andre draws the side where the bright near field shows it and
    # extends the line; the far field is where GE frames lose their echo-free corners, where the left greyscale bar
    # merges into the support (its edge jumps to x = 0) and where the T0 box clips the right side. So: walk down from
    # the top; a row counts while BOTH edges are inside the frame and the T0 box and neither edge has jumped by more
    # than SIDE_JUMP_PX from the previous row; the band ends at the first violation. cx = median row midpoint of the
    # band; half-width = half the row width; Theil–Sen slope. Rows below the band contribute nothing to the sides.
    rows_both, hw_both, mids, rows_one, hw_one = [], [], [], [], []
    prev = None; band_end = y_top; skip = 3                                     # the open-9 rounding widens the first rows fast
    for y in range(y_top, y_bottom + 1):
        row = np.nonzero(support[y])[0]
        if len(row) == 0: continue
        xl, xr = row[0], row[-1]
        vl, vr = xl > max(1, x0 + 1), xr < min(w - 2, x1 - 1)          # side not clipped by the frame border / T0 box
        if prev is not None and y - y_top > skip and (abs(xl - prev[0]) > SIDE_JUMP_PX or abs(xr - prev[1]) > SIDE_JUMP_PX):
            break                                                        # merge or lost corner: the clean band ends
        if not (vl and vr):
            if vl or vr:
                rows_one.append(y - y_top); hw_one.append(cx - xl if vl else xr - cx)
            if y - y_top > skip: break                                   # a clipped side ends the band — and the band must
            continue                                                     # START at the top (a clean far-field tail is not a band)
        rows_both.append(y - y_top); hw_both.append(0.5 * (xr - xl)); mids.append(0.5 * (xl + xr)); prev = (xl, xr); band_end = y
    info = {'trap_rows_both': len(rows_both), 'trap_rows_one': len(rows_one), 'trap_band_end': int(band_end)}
    if RULES.get('band_consistency') and len(rows_both) >= 8:
        # PASS 3 §1c — per-side straight-line consistency on the band
        ry = np.array(rows_both, np.float64); xl_a = np.array([m - hw for m, hw in zip(mids, hw_both)]); xr_a = np.array([m + hw for m, hw in zip(mids, hw_both)])
        def ts(yv, xv):
            i, j = np.triu_indices(len(yv), 1); dy = yv[j] - yv[i]; ok = dy > 0
            sl = float(np.median((xv[j] - xv[i])[ok] / dy[ok])) if ok.any() else 0.0
            return sl, float(np.median(xv - sl * yv))
        keep_rows = np.ones(len(ry), bool)
        for xv in (xl_a, xr_a):
            sl, ic = ts(ry, xv); keep_rows &= np.abs(xv - (ic + sl * ry)) <= SIDE_RESID_PX
        info['band_rows_dropped'] = int((~keep_rows).sum())
        if keep_rows.sum() >= 6:
            ry2, xl2, xr2 = ry[keep_rows], xl_a[keep_rows], xr_a[keep_rows]
            slL, icL = ts(ry2, xl2); slR, icR = ts(ry2, xr2)
            cx_b = float(np.median(0.5 * (xl2 + xr2)))
            hwL0, hwR0 = cx_b - icL, icR - cx_b                     # half-widths at y_top (row 0 of the band) per side
            if min(hwL0, hwR0) > 0 and abs(hwL0 - hwR0) > SIDE_MIRROR_FRAC * max(hwL0, hwR0):
                narrow = 'L' if hwL0 < hwR0 else 'R'
                hw_side = (cx_b - (icL + slL * ry2)) if narrow == 'L' else ((icR + slR * ry2) - cx_b)
                rows_both, hw_both, mids = list(ry2), list(hw_side), [cx_b] * len(ry2)
                info['band_mirrored'] = narrow; info['band_hw_top'] = (round(hwL0, 1), round(hwR0, 1))
            else:
                rows_both, hw_both, mids = list(ry2), list(0.5 * (xr2 - xl2)), list(0.5 * (xl2 + xr2))
    if len(rows_both) >= 6:
        cx = float(np.median(mids))
    rows_y, hw = (rows_both, hw_both) if len(rows_both) >= 6 else (rows_one, hw_one)
    if len(rows_y) >= 6:
        ry = np.array(rows_y, np.float64); rh = np.array(hw, np.float64)
        if len(ry) > 60:                                # Theil–Sen on a subsample
            idx = np.linspace(0, len(ry) - 1, 60).astype(int); ry, rh = ry[idx], rh[idx]
        i, j = np.triu_indices(len(ry), 1)
        dy = ry[j] - ry[i]; ok = dy > 0
        slope = float(np.median((rh[j] - rh[i])[ok] / dy[ok])) if ok.any() else 0.0
        a0 = float(np.median(rh - slope * ry))
        w_top = 2.0 * max(a0, w_top_meas / 2 * 0.5)
        w_bottom = 2.0 * (a0 + slope * (y_bottom - y_top))
        info['trap_seed'] = 'top_edge+max_side' + ('' if len(rows_both) >= 6 else '(one-sided)')
    else:
        w_top = w_top_meas; w_bottom = w_top; info['trap_seed'] = 'top_edge_only'
    p = {'kind': 'trap', 'sym': True, 'cx': float(cx), 'y_top': float(y_top), 'y_bottom': float(y_bottom),
         'w_top': max(4.0, float(w_top)), 'w_bottom': max(4.0, float(w_bottom))}
    # PASS 2 — the refinement sees only the clean band too (support rows below it zeroed, y_bottom pinned to the
    # band end), otherwise cover − 0.5·extra pulls the sides back onto the merged bar / the lost corner. Afterwards
    # y_bottom returns to the deepest support row and w_bottom follows the fitted side lines there.
    use_band = RULES['top60'] and len(rows_both) >= 6 and band_end > y_top + 8
    if use_band:
        sup_fit = support.copy(); sup_fit[band_end + 1:] = 0
        y_fit_bottom = float(band_end)
        p['w_bottom'] = p['w_top'] + (w_bottom - w_top) * (band_end - y_top) / max(1, (y_bottom - y_top)); p['y_bottom'] = y_fit_bottom
        info['trap_seed'] = info.get('trap_seed', '') + '+clean_band'
    else:
        sup_fit = support
    best = fit_score(render_trap(support.shape, p), sup_fit)
    steps = {'cx': 0.005 * w, 'y_top': 0.01 * h, 'y_bottom': 0.01 * h, 'w_top': 0.01 * w, 'w_bottom': 0.01 * w}
    if use_band: steps.pop('y_bottom')
    for _ in range(5):
        improved = False
        for k, st in steps.items():
            for sgn in (-1, 1):
                q = dict(p); q[k] = p[k] + sgn * st
                if q['y_bottom'] <= q['y_top'] + 2 or q['w_top'] < 4 or q['w_bottom'] < 4: continue
                v = fit_score(render_trap(support.shape, q), sup_fit)
                if v > best + 1e-4:
                    best, p, improved = v, q, True
        if not improved:
            steps = {k: v / 2 for k, v in steps.items()}
    if use_band:
        slope = (p['w_bottom'] - p['w_top']) / max(1.0, p['y_bottom'] - p['y_top'])
        along = lambda q, yb: {**q, 'y_bottom': float(yb), 'w_bottom': max(4.0, q['w_top'] + slope * (yb - q['y_top']))}
        p = along(p, y_bottom); best = fit_score(render_trap(support.shape, p), support)
        if TRAP_DEPTH == 'refine':
            st = 0.01 * h
            for _ in range(6):
                improved = False
                for sgn in (-1, 1):
                    q = along(p, p['y_bottom'] + sgn * st)
                    if q['y_bottom'] <= q['y_top'] + 2 or q['y_bottom'] > y_bottom + 1: continue
                    v = fit_score(render_trap(support.shape, q), support)
                    if v > best + 1e-4: best, p, improved = v, q, True
                if not improved: st /= 2
            info['trap_depth'] = 'refined_along_sides'
        elif TRAP_DEPTH == 'image_rows' and notblack is not None:
            widest = max(int(np.count_nonzero(support[y])) for y in range(y_top, y_bottom + 1))
            ok = []
            for y in range(y_top, y_bottom + 1):
                row = np.nonzero(support[y])[0]
                if len(row) == 0: ok.append(False); continue
                ok.append(len(row) >= TOP_WIDE_FRAC * widest and notblack[y, row[0]:row[-1] + 1].mean() >= TOP_FILL_MIN)
            ok = np.array(ok, bool); run = np.convolve(ok.astype(int), np.ones(TOP_SUSTAIN, int), 'valid')
            deep = np.nonzero(run >= TOP_SUSTAIN)[0]
            if len(deep):
                yb = y_top + int(deep[-1]) + TOP_SUSTAIN - 1          # deepest row of the deepest sustained image run
                p = along(p, yb); best = fit_score(render_trap(support.shape, p), support)
            info['trap_depth'] = 'image_rows'
        elif TRAP_DEPTH == 'profile' and notblack is not None:
            last_ok = int(band_end); yb_lim = min(h - 1, y_bottom + int(0.25 * h))
            for y in range(int(band_end), yb_lim + 1):
                wy = p['w_top'] + slope * (y - p['y_top']); xl = int(max(0, p['cx'] - wy / 2)); xr = int(min(w - 1, p['cx'] + wy / 2))
                fill = notblack[y, xl:xr + 1].mean() if xr > xl else 0.0
                if fill > R_PROFILE_MIN: last_ok = y
                elif y - last_ok > 3: break
            p = along(p, last_ok); best = fit_score(render_trap(support.shape, p), support)
            info['trap_depth'] = 'profile_walk'
    info.update(trap_sym_score=round(best, 4), trap_sym_iou=round(iou(render_trap(support.shape, p), support), 4),
                trap_side_angle_deg=round(trap_side_angle_deg(p), 2))
    # physical prior: no probe geometry narrows with depth (linear = 0°, convex / virtual convex / sector > 0°), so a
    # negative implied angle is an eroded far-field corner, not a shape — treat it as a rectangle too
    if trap_side_angle_deg(p) < 3.0:
        wm = 0.5 * (p['w_top'] + p['w_bottom'])
        pr = {**p, 'kind': 'rect', 'w_top': wm, 'w_bottom': wm}
        yb_full = pr['y_bottom']
        if use_band: pr['y_bottom'] = y_fit_bottom
        best_r = fit_score(render_trap(support.shape, pr), sup_fit)
        steps = {'cx': 0.005 * w, 'y_top': 0.01 * h, 'y_bottom': 0.01 * h, 'w': 0.01 * w}
        if use_band: steps.pop('y_bottom')
        for _ in range(4):
            improved = False
            for k, st in steps.items():
                for sgn in (-1, 1):
                    q = dict(pr)
                    if k == 'w': q['w_top'] = q['w_bottom'] = pr['w_top'] + sgn * st
                    else: q[k] = pr[k] + sgn * st
                    if q['y_bottom'] <= q['y_top'] + 2 or q['w_top'] < 4: continue
                    v = fit_score(render_trap(support.shape, q), sup_fit)
                    if v > best_r + 1e-4:
                        best_r, pr, improved = v, q, True
            if not improved:
                steps = {k: v / 2 for k, v in steps.items()}
        if use_band:
            pr['y_bottom'] = yb_full; best_r = fit_score(render_trap(support.shape, pr), support)
        info.update(rect_score=round(best_r, 4), rect_iou=round(iou(render_trap(support.shape, pr), support), 4))
        return pr, info
    return p, info


def fit_support(support, union=None, notblack=None, xlim=None):
    """Symmetric fan on the largest component; if a union of large components exists and one symmetric fan
    explains it — covers >= UNION_COVER of the union at <= UNION_MAX_RATIO times its area — the union wins
    (a cone split by an echo-free band; IoU is the wrong test there because the hole is real)."""
    p, info = fit_fan(support, notblack, xlim)
    if union is not None:
        pu, iu = fit_fan_sym(union, notblack)
        if pu is not None:
            fan_u = render_fan(union.shape, pu)
            cover = np.count_nonzero((fan_u > 0) & (union > 0)) / max(1, np.count_nonzero(union))
            ratio = np.count_nonzero(fan_u) / max(1, np.count_nonzero(union))
            iu = {**iu, 'union_cover': round(cover, 3), 'union_area_ratio': round(ratio, 2)}
            if cover >= UNION_COVER and ratio <= UNION_MAX_RATIO:
                iu = {**iu, 'model': 'fan_sym', 'fit_iou': round(cover, 4), 'fit_score': round(cover, 4), 'union': True}
                return pu, iu, union
            info = {**info, 'union_rejected': {k: iu[k] for k in ('union_cover', 'union_area_ratio')}}
    return p, info, support


def fit_fan(support, notblack=None, xlim=None):
    """Model selection among the SYMMETRIC models: fan_sym | trap_sym | rect. The fan is preferred unless the
    trapezoid/rectangle beats it by more than FAN_PREFERENCE (IoU vs support). The free fan/quad are fitted
    only for the diagnostics (th_*_free_deg, asym_deg, axis_tilt_deg, fan_iou_free)."""
    if np.count_nonzero(support) < 50:
        return None, {'reason': 'support_too_small'}
    pf, inf_f = fit_fan_sym(support, notblack)
    pt, inf_t = fit_trap_sym(support, notblack, xlim)
    info = {**{k: v for k, v in inf_f.items() if k != 'reason'}, **{k: v for k, v in inf_t.items() if k != 'reason'}}
    if pf is None and pt is None:
        return None, {**info, 'reason': inf_f.get('reason') or inf_t.get('reason')}
    st = (inf_t.get('rect_score', inf_t.get('trap_sym_score', -1)) if pt is not None else -1)
    sf = inf_f.get('fan_sym_score', -1) if pf is not None else -1
    # top-edge flatness: width of the first wide row band relative to the frame
    ys, xs = np.nonzero(support)
    y0 = ys.min(); ext = np.array([(np.nonzero(support[y])[0][[0, -1]] if support[y].any() else (0, -1)) for y in range(y0, ys.max() + 1)])
    widths = ext[:, 1] - ext[:, 0] + 1; wide = np.nonzero(widths >= 0.30 * widths.max())[0]
    top_frac = float(widths[wide[0]] / support.shape[1]) if len(wide) else 0.0
    info['top_edge_frac'] = round(top_frac, 3)
    prefer_fan = top_frac < TOP_FLAT_FRAC
    fan_wins = pf is not None and (sf >= st - FAN_PREFERENCE if prefer_fan else sf > st + FAN_PREFERENCE)
    if pt is None or fan_wins:
        info['model'] = 'fan_sym'; info['fit_score'] = round(sf, 4); info['fit_iou'] = inf_f['fan_sym_iou']
        return pf, info
    info['model'] = pt['kind'] if pt['kind'] == 'rect' else 'trap_sym'; info['fit_score'] = round(st, 4)
    info['fit_iou'] = inf_t.get('rect_iou', inf_t.get('trap_sym_iou'))
    return pt, info


def scale_params(p, f):
    q = dict(p)
    if p['kind'] in ('trap', 'rect') and 'cx' in p:
        for k in ('cx', 'y_top', 'y_bottom', 'w_top', 'w_bottom'):
            q[k] = p[k] * f
        return q
    if p['kind'] == 'rect':
        for k in ('x0', 'y0', 'x1', 'y1'):
            q[k] = p[k] * f
        q['x1'] += f - 1; q['y1'] += f - 1
    elif p['kind'] == 'poly':
        q['pts'] = [[x * f, y * f] for x, y in p['pts']]
    else:
        for k in ('ax', 'ay', 'r_in', 'r_out'):
            q[k] = p[k] * f
    return q


def keep_fullres(p, full_shape):
    m = render_fan(full_shape, scale_params(p, DOWN))
    if MARGIN_PX > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * MARGIN_PX + 1, 2 * MARGIN_PX + 1))
        m = cv2.erode(m, k)
    return m


def support_edges_touched(support):
    """How many frame edges the support reaches (within 2 px)."""
    return int(support[:2].any()) + int(support[-2:].any()) + int(support[:, :2].any()) + int(support[:, -2:].any())


def confidence(fan_s, support_s, opened_s, static_s=None, gray_s=None, fit_override=None, bg=None):
    """Crude confidence per kickoff §5. Components are returned so thresholds can be tuned.
    Withhold gates, in order: background_not_dark / no_background (tuning pass 1, background model),
    interior_not_ultrasound, masks_too_little (addendum §3: only withhold if the interior is also borderline or
    the support does not reach 2 frame edges — otherwise propose with the nothing_much_to_mask flag)."""
    fit = fit_override if fit_override is not None else fit_score(fan_s, support_s)
    fan_area = max(1, np.count_nonzero(fan_s))
    outside_all = np.count_nonzero((opened_s > 0) & (fan_s == 0)) / fan_area
    outside_blob = outside_all
    if RULES['conf_bbox'] and fan_s.any():
        # only bright blobs near the cone count as "content the shape excludes"; a full-screen capture's UI panels
        # (GE Venue) sit outside the cone's bounding box and are not evidence against the fit
        ys_, xs_ = np.nonzero(fan_s); h_, w_ = fan_s.shape
        my, mx = int(0.05 * (ys_.max() - ys_.min() + 1)), int(0.05 * (xs_.max() - xs_.min() + 1))
        box = np.zeros_like(fan_s); box[max(0, ys_.min() - my):min(h_, ys_.max() + my + 1), max(0, xs_.min() - mx):min(w_, xs_.max() + mx + 1)] = 1
        n_, lab_, stats_, _ = cv2.connectedComponentsWithStats(((opened_s > 0) & (fan_s == 0)).astype(np.uint8), connectivity=8)
        touching = np.zeros_like(fan_s)
        for i in range(1, n_):
            m_ = lab_ == i
            if (m_ & (box > 0)).any(): touching |= m_
        outside_blob = np.count_nonzero(touching) / fan_area
    comp = {'fit_iou': round(iou(fan_s, support_s), 4), 'fit_score': round(fit, 4), 'outside_blob_frac': round(outside_blob, 4), 'outside_blob_frac_all': round(outside_all, 4)}
    conf = fit - 0.5 * outside_blob
    if static_s is not None:
        inside_static = np.count_nonzero((static_s > 0) & (fan_s > 0)) / fan_area
        comp['static_inside_frac'] = round(inside_static, 4)
        conf -= 1.0 * inside_static
    frac_masked = 1.0 - fan_area / fan_s.size
    comp['masked_frac'] = round(frac_masked, 4)
    if bg is not None:
        comp['bg_level'], comp['bg_frac'] = bg[0], round(bg[1], 4)
        if bg[0] > BG_MAX_LEVEL:
            conf = 0.0; comp['withheld'] = 'background_not_dark'
        elif bg[1] < BG_MIN_FRAC:
            conf = 0.0; comp['withheld'] = 'no_background'
    borderline = True
    if gray_s is not None:
        inside = gray_s[fan_s > 0].astype(np.float32)
        comp['interior_mean'] = round(float(inside.mean()), 1); comp['interior_std'] = round(float(inside.std()), 1)
        borderline = bool(inside.mean() > 120 or inside.std() < 25)
        if (inside.mean() > 150 or inside.std() < 15) and 'withheld' not in comp:
            conf = 0.0; comp['withheld'] = 'interior_not_ultrasound'
    if frac_masked < MIN_MASK_FRAC and 'withheld' not in comp:
        edges = support_edges_touched(support_s); comp['support_edges'] = edges
        if borderline or edges < 2:
            conf = 0.0; comp['withheld'] = 'masks_too_little'
        else:
            comp['flag'] = 'nothing_much_to_mask'
    comp['conf'] = round(max(0.0, min(1.0, conf)), 4)
    return comp


def finish_fit(p, info, g, support, opened, static=None, bg=None):
    """Shared tail: far-field completion (fan only) -> confidence -> full-res keep."""
    if p is not None and p['kind'] == 'fan':
        p, rinfo = refine_fan_radii(p, g, static, bg=(bg[0] if bg else 0)); info = {**info, **rinfo}
        if p.get('sym'):
            p['th_l'], p['th_r'] = -p['half_angle'], p['half_angle']
    fan_s = render_fan(g.shape, p)
    comp = confidence(fan_s, support, opened, static, g, fit_override=info.get('fit_score') if info.get('union') else None, bg=bg)
    return p, {**info, **comp}, fan_s


def tier_t1(gray_full, bound=None):
    """bound: optional full-res 0/1 mask (the T0 region box); everything outside it is treated as black."""
    t0 = time.perf_counter()
    gf = gray_full if bound is None else gray_full * bound
    g = small(gf)
    # background model: the mode of the frame (0 for every vendor export seen so far, 22 for a GE Venue full-screen
    # capture). Measured on the unbounded frame so a DICOM region box does not create a fake black background.
    bg = background_stats(small(gray_full))
    bg_info = {'bg_level': bg[0], 'bg_frac': round(bg[1], 4)}
    if bg[0] > BG_MAX_LEVEL:
        return None, {'ms': (time.perf_counter() - t0) * 1000, 'conf': 0.0, 'withheld': 'background_not_dark', **bg_info}
    if bg[1] < BG_MIN_FRAC:
        return None, {'ms': (time.perf_counter() - t0) * 1000, 'conf': 0.0, 'withheld': 'no_background', **bg_info}
    support, opened, area = clean_support(g, bg=bg[0])
    notblack = (g > bg[0] + T_LOW).astype(np.uint8)
    if TOP_FILL_SRC == 'density':
        notblack = clean_support.last_region.copy()                # §1d evaluation: the smoothed density region instead of the raw mask
    if clean_support.last_removed.any():
        notblack[clean_support.last_removed > 0] = 0            # dropped furniture is not "image" for the r_in / top rules either
    xlim = None
    if bound is not None:
        bx = np.nonzero(bound.any(0))[0]
        if len(bx): xlim = (int(bx[0]) // DOWN, int(bx[-1]) // DOWN)
    p, info, support = fit_support(support, clean_support.last_union, notblack, xlim)
    if p is None:
        return None, {'ms': (time.perf_counter() - t0) * 1000, **info, 'conf': 0.0, **bg_info}
    if RULES['t0_depth_rect'] and bound is not None and p.get('kind') == 'rect' and 'cx' in p:
        # T0 rule (pass 2, rect only): the linear image runs to the region box bottom; Andre's depth matched it on 2/2
        by = np.nonzero(bound.any(1))[0]
        if len(by):
            p['y_bottom'] = float(by.max()) / DOWN; info['t0_depth'] = 'bound_bottom'
    p, info, _ = finish_fit(p, info, g, support, opened, bg=bg)
    keep = keep_fullres(p, gray_full.shape)
    if bound is not None:
        keep = keep * bound
    ms = (time.perf_counter() - t0) * 1000
    return keep, {'ms': round(ms, 1), **info, 'params_small': p, 'support_s': support, 'opened_s': opened}


def tier_t2(frame_paths, gray_full):
    """Static-overlay map from N sampled frames; T2 (spec) and T2max (variant)."""
    t0 = time.perf_counter()
    idx = np.linspace(0, len(frame_paths) - 1, min(T2_N, len(frame_paths))).round().astype(int)
    stack = []
    for i in idx:
        g, _ = imread_gray_rgb(frame_paths[i])
        stack.append(small(g).astype(np.float32))
    st = np.stack(stack)
    t_read = time.perf_counter()
    mean = st.mean(0); std = st.std(0); mx = st.max(0)
    static = ((std < T2_STD) & (mean > T2_MEAN)).astype(np.uint8)
    # a little dilation so the overlay's anti-aliased fringe goes too
    static = cv2.dilate(static, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    g1 = small(gray_full)
    out = {'ms_read': round((t_read - t0) * 1000, 1), 'n_frames': int(len(idx)),
           'static_s': static, 'static_frac': round(float(static.mean()), 4)}
    # T2 per kickoff: frame-1 support minus static overlay
    t1a = time.perf_counter()
    bg = background_stats(g1)
    sup, opened, _ = clean_support(g1, remove=static, bg=bg[0])
    p, info, sup = fit_support(sup, clean_support.last_union, ((g1 > bg[0] + T_LOW) & (static == 0) & (clean_support.last_removed == 0)).astype(np.uint8))
    res = {**info}
    if p is not None:
        p, info, fan_s = finish_fit(p, info, g1, sup, opened, static, bg=bg)
        res.update(info)
        res['keep'] = keep_fullres(p, gray_full.shape); res['params_small'] = p
    else:
        res['conf'] = 0.0
    res['ms'] = round((time.perf_counter() - t1a) * 1000 + out['ms_read'], 1)
    out['t2'] = res
    # T2max variant: support from the temporal max projection minus static overlay
    t1b = time.perf_counter()
    gmax = np.clip(mx, 0, 255).astype(np.uint8)
    sup2, opened2, _ = clean_support(gmax, remove=static, bg=bg[0])
    p2, info2, sup2 = fit_support(sup2, clean_support.last_union, ((gmax > bg[0] + T_LOW) & (static == 0) & (clean_support.last_removed == 0)).astype(np.uint8))
    res2 = {**info2}
    if p2 is not None:
        p2, info2, fan2 = finish_fit(p2, info2, gmax, sup2, opened2, static, bg=bg)
        res2.update(info2)
        res2['keep'] = keep_fullres(p2, gray_full.shape); res2['params_small'] = p2
    else:
        res2['conf'] = 0.0
    res2['ms'] = round((time.perf_counter() - t1b) * 1000 + out['ms_read'], 1)
    out['t2max'] = res2
    return out


def tier_t0(dicom_path, full_shape):
    import pydicom
    t0 = time.perf_counter()
    ds = pydicom.dcmread(dicom_path, stop_before_pixels=True)
    seq = ds.get((0x0018, 0x6011))
    if seq is None:
        return None, {'ms': (time.perf_counter() - t0) * 1000, 'reason': 'no_region_sequence'}
    keep = np.zeros(full_shape, np.uint8)
    regs = []
    for it in seq.value:
        x0, y0, x1, y1 = (int(it.RegionLocationMinX0), int(it.RegionLocationMinY0),
                          int(it.RegionLocationMaxX1), int(it.RegionLocationMaxY1))
        x1 = min(x1, full_shape[1] - 1); y1 = min(y1, full_shape[0] - 1)
        keep[y0:y1 + 1, x0:x1 + 1] = 1
        regs.append({'fmt': int(it.get('RegionSpatialFormat', -1)), 'dt': int(it.get('RegionDataType', -1)),
                     'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
                     'refX': int(it.get('ReferencePixelX0', -9999)), 'refY': int(it.get('ReferencePixelY0', -9999))})
    if MARGIN_PX > 0:
        keep = cv2.erode(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * MARGIN_PX + 1, 2 * MARGIN_PX + 1)))
    return keep, {'ms': round((time.perf_counter() - t0) * 1000, 1), 'regions': regs, 'conf': 1.0}

# ----------------------------------------------------------------------------- scoring / output

BAND_PX = 6  # supplementary metric: ignore a +/-6 px band around the reference boundary (reference uncertainty)

def score(keep, ref):
    k = keep > 0; r = ref > 0
    ref_masked = np.count_nonzero(~r); ref_kept = np.count_nonzero(r)
    leak = np.count_nonzero(k & ~r) / ref_masked if ref_masked else 0.0
    over = np.count_nonzero(~k & r) / ref_kept if ref_kept else 0.0
    kb = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * BAND_PX + 1, 2 * BAND_PX + 1))
    r8 = ref.astype(np.uint8)
    core_masked = cv2.dilate(r8, kb) == 0      # ref-masked, farther than BAND_PX from the boundary
    core_kept = cv2.erode(r8, kb) > 0          # ref-kept, farther than BAND_PX from the boundary
    leak_core = np.count_nonzero(k & core_masked) / max(1, np.count_nonzero(core_masked))
    over_core = np.count_nonzero(~k & core_kept) / max(1, np.count_nonzero(core_kept))
    return {'iou': round(iou(k, r), 4), 'leak': round(leak, 5), 'over_blank': round(over, 5),
            'leak_core6': round(leak_core, 5), 'over_core6': round(over_core, 5)}


def outline(img, mask, color, thick=2):
    cs, _ = cv2.findContours((mask > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(img, cs, -1, color, thick)


def contact_sheet(rgb, ref, tiers, path, title):
    """frame 1 with outlines + one dimmed panel per tier (blanked area darkened)."""
    h, w = rgb.shape[:2]
    scale = 480 / h
    def rs(im):
        return cv2.resize(im, (int(w * scale), 480), interpolation=cv2.INTER_AREA)
    base = rgb.copy()
    colors = {'ref': (0, 255, 0), 'T0': (0, 255, 255), 'T1': (0, 0, 255), 'T0T1': (0, 140, 255), 'T2': (255, 255, 0), 'T2max': (255, 0, 255)}
    if ref is not None:
        outline(base, ref, colors['ref'], 3)
    for name, keep in tiers.items():
        if keep is not None:
            outline(base, keep, colors[name], 2)
    panels = [rs(base)]
    labels = ['outlines: ref=green T0=yellow T1=red T0T1=orange T2=cyan T2max=magenta']
    for name, keep in tiers.items():
        if keep is None:
            continue
        pan = rgb.copy()
        pan[keep == 0] = (pan[keep == 0] * 0.25).astype(np.uint8)
        if ref is not None:
            leakpx = (keep > 0) & (ref == 0)
            pan[leakpx] = (0, 0, 255)  # red = leak (kept but ref-masked)
            overpx = (keep == 0) & (ref > 0)
            pan[overpx] = (255, 128, 0)  # orange = over-blank
        panels.append(rs(pan)); labels.append(f'{name} keep (red=leak, orange=over-blank)')
    sheet = np.concatenate(panels, 1)
    bar = np.zeros((40, sheet.shape[1], 3), np.uint8)
    cv2.putText(bar, title, (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    sheet = np.concatenate([bar, sheet], 0)
    x = 0
    for pan, lab in zip(panels, labels):
        cv2.putText(sheet, lab, (x + 6, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
        x += pan.shape[1]
    cv2.imwrite(path, sheet)


def load_ref(refs, clip, full_shape):
    r = refs.get(clip)
    if not r:
        return None, None
    p = r['keep']
    if p['kind'] == 'none':
        return None, r.get('note')
    if p['kind'] == 'rect_px' or p['kind'] == 'rect':
        q = {'kind': 'rect', 'x0': p['x0'], 'y0': p['y0'], 'x1': p['x1'], 'y1': p['y1']}
    elif p['kind'] == 'poly_px':
        q = {'kind': 'poly', 'pts': p['pts']}
    else:  # fan_px, full-res params, th in degrees (0 = down, + right)
        q = {'kind': 'fan', 'ax': p['ax'], 'ay': p['ay'], 'r_in': p['r_in'], 'r_out': p['r_out'],
             'th_l': math.radians(p['th_l_deg']), 'th_r': math.radians(p['th_r_deg'])}
    m = render_fan(full_shape, q)
    if 'clip_to_box' in r:
        b = r['clip_to_box']; box = np.zeros_like(m); box[b['y0']:b['y1'] + 1, b['x0']:b['x1'] + 1] = 1; m = m * box
    for extra in r.get('subtract', []):
        e = extra
        if e['kind'] == 'rect_px':
            m[e['y0']:e['y1'] + 1, e['x0']:e['x1'] + 1] = 0
    return m, r.get('note')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'out'))
    ap.add_argument('--clips', default=None)
    ap.add_argument('--refs', default=os.path.join(os.path.dirname(__file__), 'refs.json'))
    ap.add_argument('--dicoms', default=os.path.join(os.path.dirname(__file__), 'dicoms.json'))
    ap.add_argument('--dump-candidates', action='store_true')
    a = ap.parse_args()
    refs = json.load(open(a.refs)) if os.path.exists(a.refs) else {}
    dicoms = json.load(open(a.dicoms)) if os.path.exists(a.dicoms) else {}
    clips = sorted(os.listdir(a.frames)) if not a.clips else a.clips.split(',')
    results = {}
    for clip in clips:
        d = os.path.join(a.frames, clip)
        frames = sorted(glob.glob(os.path.join(d, 'frame_*.png')))
        if not frames:
            continue
        od = os.path.join(a.out, clip); os.makedirs(od, exist_ok=True)
        t_dec = time.perf_counter()
        gray, rgb = imread_gray_rgb(frames[0])
        ms_decode = (time.perf_counter() - t_dec) * 1000
        H, W = gray.shape
        ref, note = load_ref(refs, clip, gray.shape)
        r = {'w': W, 'h': H, 'frames': len(frames), 'ms_decode_frame1': round(ms_decode, 1), 'ref_note': note}
        tiers = {}
        # T0
        if clip in dicoms:
            k0, i0 = tier_t0(dicoms[clip], gray.shape)
            r['T0'] = {k: v for k, v in i0.items()}
            if k0 is not None:
                tiers['T0'] = k0; cv2.imwrite(os.path.join(od, 't0_keep.png'), k0 * 255)
                if ref is not None: r['T0'].update(score(k0, ref))
        # T1
        k1, i1 = tier_t1(gray)
        r['T1'] = {k: v for k, v in i1.items() if k not in ('support_s', 'opened_s')}
        if k1 is not None:
            tiers['T1'] = k1; cv2.imwrite(os.path.join(od, 't1_keep.png'), k1 * 255)
            cv2.imwrite(os.path.join(od, 't1_support_small.png'), i1['support_s'] * 255)
            if ref is not None: r['T1'].update(score(k1, ref))
        # T0∩T1 (DICOM): the tag as a hard outer bound, the fan/quad inside it
        if 'T0' in tiers:
            k01, i01 = tier_t1(gray, bound=tiers['T0'])
            r['T0T1'] = {k: v for k, v in i01.items() if k not in ('support_s', 'opened_s')}
            r['T0T1']['ms'] = round(r['T0']['ms'] + i01['ms'], 1)
            if k01 is not None:
                tiers['T0T1'] = k01; cv2.imwrite(os.path.join(od, 't0t1_keep.png'), k01 * 255)
                if ref is not None: r['T0T1'].update(score(k01, ref))
        # T2 (clips only)
        if len(frames) > 1:
            o2 = tier_t2(frames, gray)
            cv2.imwrite(os.path.join(od, 't2_static.png'), o2['static_s'] * 255)
            for name in ('t2', 't2max'):
                res = o2[name]; key = 'T2' if name == 't2' else 'T2max'
                r[key] = {k: v for k, v in res.items() if k not in ('keep',)}
                r[key]['static_frac'] = o2['static_frac']; r[key]['n_frames'] = o2['n_frames']
                if 'keep' in res:
                    tiers[key] = res['keep']; cv2.imwrite(os.path.join(od, f'{name}_keep.png'), res['keep'] * 255)
                    if ref is not None: r[key].update(score(res['keep'], ref))
        if ref is not None:
            cv2.imwrite(os.path.join(od, 'ref_keep.png'), ref * 255)
        contact_sheet(rgb, ref, tiers, os.path.join(od, 'contact.png'), f'{clip}  {W}x{H}  {len(frames)} f')
        results[clip] = r
        summary = ' '.join(f"{t}: iou={r[t].get('iou','-')} leak={r[t].get('leak','-')} conf={r[t].get('conf','-')} {r[t].get('ms','-')}ms"
                           for t in ('T0', 'T1', 'T0T1', 'T2', 'T2max') if t in r)
        print(f'{clip:16s} {W}x{H} {len(frames):4d}f  {summary}')
        if a.dump_candidates:
            for t in ('T1', 'T2max'):
                if t in r and 'params_small' in r[t]:
                    print(f'   {t} params(full-res): {json.dumps(scale_params(r[t]["params_small"], DOWN))}')
    def clean(o):
        if isinstance(o, dict): return {k: clean(v) for k, v in o.items() if k not in ('params_small',) or True}
        if isinstance(o, (np.floating, np.integer)): return o.item()
        if isinstance(o, list): return [clean(v) for v in o]
        return o
    with open(os.path.join(a.out, 'results.json'), 'w') as f:
        json.dump(clean(results), f, indent=1)
    # markdown table
    lines = ['| clip | size | frames | tier | IoU | leak | over-blank | leak_core6 | over_core6 | conf | ms |', '|---|---|---|---|---|---|---|---|---|---|---|']
    for clip, r in results.items():
        for t in ('T0', 'T1', 'T0T1', 'T2', 'T2max'):
            if t in r:
                x = r[t]
                lines.append(f"| {clip} | {r['w']}x{r['h']} | {r['frames']} | {t} | {x.get('iou','—')} | {x.get('leak','—')} | {x.get('over_blank','—')} | {x.get('leak_core6','—')} | {x.get('over_core6','—')} | {x.get('conf','—')} | {x.get('ms','—')} |")
    with open(os.path.join(a.out, 'results.md'), 'w') as f:
        f.write('\n'.join(lines) + '\n')


def dump_constants():
    """`python3 automask_spike.py --dump-constants` → JSON of every frozen constant and the RULES toggles, consumed by
    scripts/automask_eval/gen-constants.ts to generate shared/automask/constants.ts (AUTOMASK_2A_GO.md §2: generated, not typed)."""
    g = globals()
    out = {k: g[k] for k in sorted(g) if k.isupper() and isinstance(g[k], (int, float, str, bool)) and not k.startswith('_')}
    out['RULES'] = dict(RULES)
    out['_source'] = 'automask_spike.py'; out['_frozen'] = '2026-09-06'
    return out


if __name__ == '__main__' and '--propose-png' in sys.argv:
    # Round 2A: run the frozen proposer on ONE png and print the fixture-style proposal (keep = full-res shape).
    #   python3 automask_spike.py --propose-png frame.png [--bound x0,y0,x1,y1]
    _i = sys.argv.index('--propose-png'); _png = sys.argv[_i + 1]
    _bound = None
    if '--bound' in sys.argv:
        _x0, _y0, _x1, _y1 = [int(v) for v in sys.argv[sys.argv.index('--bound') + 1].split(',')]
        _bound = {'x0': _x0, 'y0': _y0, 'x1': _x1, 'y1': _y1}
    _g, _ = imread_gray_rgb(_png); _h, _w = _g.shape; _bm = None
    if _bound:
        _bm = np.zeros((_h, _w), np.uint8); _bm[_bound['y0']:_bound['y1'] + 1, _bound['x0']:_bound['x1'] + 1] = 1
    _keep, _info = tier_t1(_g, bound=_bm)
    _out = {'clip_id': os.path.splitext(os.path.basename(_png))[0], 'w': _w, 'h': _h, 'bound': _bound, 'margin_px': MARGIN_PX,
            'tier': 'T0T1' if _bound else 'T1', 'model': _info.get('model'), 'conf': float(_info.get('conf', 0.0) or 0.0),
            'withheld': None, 'flag': _info.get('flag'), 'keep': None, 'expected': 'propose',
            'components': {k: (v if not isinstance(v, (np.floating, np.integer)) else float(v)) for k, v in _info.items() if k in ('fit_score', 'fit_iou', 'outside_blob_frac', 'masked_frac', 'interior_mean', 'interior_std', 'bg_level', 'bg_frac', 'axis', 'rin_rule', 'reseeded', 'trap_depth', 't0_depth', 'union', 'top_edge_frac')}}
    if _keep is None or _out['conf'] <= 0.0:
        _out['withheld'] = _info.get('withheld') or _info.get('reason') or 'no_fit'
    else:
        _q = scale_params(_info['params_small'], DOWN)
        if _q['kind'] == 'fan':
            _out['keep'] = {k: (float(v) if isinstance(v, (int, float, np.floating)) and not isinstance(v, bool) else v) for k, v in _q.items()}
            _out['keep']['th_l'], _out['keep']['th_r'] = -_out['keep']['half_angle'], _out['keep']['half_angle']
        else:
            _out['keep'] = {'kind': _q['kind'], 'cx': float(_q['cx']), 'y_top': float(_q['y_top']), 'y_bottom': float(_q['y_bottom']), 'w_top': float(_q['w_top']), 'w_bottom': float(_q['w_bottom']), 'sym': True}
    print(json.dumps(_out, indent=1)); sys.exit(0)

if __name__ == '__main__' and '--dump-constants' in sys.argv:
    print(json.dumps(dump_constants(), indent=1, sort_keys=True)); sys.exit(0)

if __name__ == '__main__':
    main()

