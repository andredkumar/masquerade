#!/usr/bin/env python3
"""
Track 0 bench — the auto-mask proposer on the sandbox corpus, with a review page per clip.

  python3 bench.py                 # build proposals + pages for every clip in ../sandbox/manifest.csv
  python3 bench.py --serve         # same, then serve http://localhost:8765 (pages POST verdicts to reviews.json)
  python3 bench.py --report        # print / write the results table joined with reviews.json
  python3 bench.py --clips a,b --rebuild --sandbox <dir> --port 8765

Layout it writes (all inside the sandbox, all PHI, never committed):
  <sandbox>/bench/_frames/<clip>/frame_%06d.png     frame cache (ffmpeg -vsync 0 -compression_level 1; pydicom for DICOM)
  <sandbox>/bench/_static/{shape.js,review.js,style.css}
  <sandbox>/bench/<clip>/{frame1.png, proposal.json, review.html}
  <sandbox>/bench/index.html, reviews.json
  <sandbox>/results/<date>_bench.md                  (--report)

Proposal tiers (the spike's, unchanged): T0 (DICOM box) → T0T1 (T1 bounded by the box) or T1.
T2ext (amendment §3, evaluation only): temporal max projection may INCREASE the fitted depth and nothing
else; reported as a suggestion, never applied.

The parametric shape the page renders (bench_static/shape.js) is the same function Round 2B's canvas
layer needs; it is the one part of this bench that is not throwaway.
"""
from __future__ import annotations
import argparse, csv, glob, json, math, os, re, shutil, subprocess, sys, time, datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import automask_spike as A  # noqa: E402

BENCH_VERSION = 'bench v4 — pass 2: top width (arc stays) joint control; references absolute'
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
DEFAULT_SANDBOX = os.path.abspath(os.path.join(REPO, '..', 'sandbox'))
VIDEO_EXT = {'.mp4', '.mov', '.avi', '.m4v', '.mkv'}
STILL_EXT = {'.png', '.jpg', '.jpeg'}


FFMPEG7 = '/opt/homebrew/opt/ffmpeg@7/bin/ffmpeg'   # what scripts/sandbox/up.sh puts first on the server's PATH


def ffmpeg_bin():
    """Prefer the same ffmpeg the sandbox server uses (ffmpeg@7), then PATH, then imageio's bundle."""
    if os.path.exists(FFMPEG7):
        return FFMPEG7
    p = shutil.which('ffmpeg')
    if p:
        return p
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def ffmpeg_extract(clip_path, pattern):
    """The app's single-pass args (`-vsync 0 -compression_level 1`, frameExtractor.ts:319). ffmpeg >= 8 removed
    `-vsync`; `-fps_mode passthrough` is the same behaviour under the modern name — retried only if needed."""
    base = [ffmpeg_bin(), '-hide_banner', '-loglevel', 'error', '-y', '-i', clip_path]
    r = subprocess.run(base + ['-vsync', '0', '-compression_level', '1', pattern], capture_output=True, text=True)
    if r.returncode != 0 and 'vsync' in (r.stderr or ''):
        r = subprocess.run(base + ['-fps_mode', 'passthrough', '-compression_level', '1', pattern], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:400])


# ----------------------------------------------------------------------------- frames

def ensure_frames(clip_path, out_dir, rebuild=False):
    """Extract the clip into out_dir/frame_%06d.png with the app's own conventions. Returns sorted paths."""
    have = sorted(glob.glob(os.path.join(out_dir, 'frame_*.png')))
    if have and not rebuild:
        return have
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    ext = os.path.splitext(clip_path)[1].lower()
    if ext == '.dcm':
        import pydicom
        from PIL import Image
        ds = pydicom.dcmread(clip_path)
        arr = ds.pixel_array
        n = int(ds.get('NumberOfFrames', 1))
        if n == 1:
            arr = arr[None]
        for i, fr in enumerate(arr):
            Image.fromarray(fr).save(os.path.join(out_dir, f'frame_{i + 1:06d}.png'), compress_level=1)
    elif ext in STILL_EXT:
        im = cv2.imread(clip_path, cv2.IMREAD_COLOR)
        cv2.imwrite(os.path.join(out_dir, 'frame_000001.png'), im)
    elif ext in VIDEO_EXT:
        ffmpeg_extract(clip_path, os.path.join(out_dir, 'frame_%06d.png'))
    else:
        raise ValueError(f'unsupported clip type: {clip_path}')
    return sorted(glob.glob(os.path.join(out_dir, 'frame_*.png')))


# ----------------------------------------------------------------------------- shapes (full-res, page-ready)

def side_line(a, b):
    return {'x0': float(a[0]), 'y0': float(a[1]), 'x1': float(b[0]), 'y1': float(b[1])}


def poly_depth_params(pts, w, h):
    """Decompose a fitted polygon into top chain + two side lines + bottom, for the depth control."""
    pts = [[float(x), float(y)] for x, y in pts]
    n = len(pts)
    ys = [p[1] for p in pts]; xs = [p[0] for p in pts]
    y_top, y_bot = min(ys), max(ys); cx = sum(xs) / n
    edges = []
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < 1e-6 or abs(dy) < 0.35 * abs(dx):
            continue
        border = (a[0] <= 1 and b[0] <= 1) or (a[0] >= w - 2 and b[0] >= w - 2) or (a[1] <= 1 and b[1] <= 1) or (a[1] >= h - 2 and b[1] >= h - 2)
        if border:
            continue
        edges.append((L, a, b))
    edges.sort(key=lambda e: -e[0])
    left = next(((a, b) for L, a, b in edges if (a[0] + b[0]) / 2 < cx), None)
    right = next(((a, b) for L, a, b in edges if (a[0] + b[0]) / 2 >= cx), None)
    xmin, xmax = min(xs), max(xs)
    left_l = side_line(*left) if left else {'x0': xmin, 'y0': y_top, 'x1': xmin, 'y1': y_bot}
    right_l = side_line(*right) if right else {'x0': xmax, 'y0': y_top, 'x1': xmax, 'y1': y_bot}
    # make both lines point downward (y1 > y0) so extension math is uniform
    for l in (left_l, right_l):
        if l['y1'] < l['y0']:
            l['x0'], l['x1'], l['y0'], l['y1'] = l['x1'], l['x0'], l['y1'], l['y0']
    top_chain = sorted([p for p in pts if p[1] < (y_top + y_bot) / 2], key=lambda p: p[0])
    return {'kind': 'poly', 'pts': pts, 'top_chain': top_chain, 'left': left_l, 'right': right_l, 'y_bottom': float(y_bot), 'y_bottom_fit': float(y_bot)}


def to_page_shape(p_small, w, h):
    q = A.scale_params(p_small, A.DOWN)
    if q['kind'] == 'fan':
        out = {k: (float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v) for k, v in q.items()}
        if 'half_angle' in out:
            out['th_l'], out['th_r'] = -out['half_angle'], out['half_angle']
        return out
    if q['kind'] in ('trap', 'rect') and 'cx' in q:
        return {'kind': q['kind'], 'cx': float(q['cx']), 'y_top': float(q['y_top']), 'y_bottom': float(q['y_bottom']),
                'w_top': float(q['w_top']), 'w_bottom': float(q['w_bottom']), 'sym': True}
    if q['kind'] == 'poly':
        return poly_depth_params(q['pts'], w, h)
    return {'kind': 'rect', 'x0': q['x0'], 'y0': q['y0'], 'x1': q['x1'], 'y1': q['y1']}


def trap_half_width(shape, y):
    t = (y - shape['y_top']) / max(1e-6, shape['y_bottom'] - shape['y_top'])
    return 0.5 * (shape['w_top'] + t * (shape['w_bottom'] - shape['w_top']))


def trap_side_angle_deg(shape):
    return math.degrees(math.atan2((shape['w_bottom'] - shape['w_top']) / 2, max(1e-6, shape['y_bottom'] - shape['y_top'])))


# ----------------------------------------------------------------------------- T2ext (extend-only)

def x_on_line(l, y):
    if abs(l['y1'] - l['y0']) < 1e-9:
        return l['x0']
    return l['x0'] + (y - l['y0']) * (l['x1'] - l['x0']) / (l['y1'] - l['y0'])


def t2ext(frames, p_small, shape_full, w, h):
    """Temporal max projection (20 frames, 4x) may only push the depth outward. Returns (value, delta) in full-res px."""
    if len(frames) < 2 or p_small is None:
        return None
    idx = np.linspace(0, len(frames) - 1, min(A.T2_N, len(frames))).round().astype(int)
    mx = None
    for i in idx:
        g, _ = A.imread_gray_rgb(frames[i]); gs = A.small(g)
        mx = gs if mx is None else np.maximum(mx, gs)
    bg = A.background_stats(mx)
    if p_small['kind'] == 'fan':
        q, _ = A.refine_fan_radii(p_small, mx, bg=bg[0])
        r_out = max(p_small['r_out'], q['r_out']) * A.DOWN
        return {'key': 'r_out', 'value': float(r_out), 'delta': float(r_out - shape_full['r_out'])}
    if shape_full['kind'] in ('trap', 'rect', 'poly'):
        nb = (mx > bg[0] + A.T_LOW).astype(np.float32)
        hs, ws = nb.shape
        y = int(shape_full['y_bottom'] / A.DOWN)
        while y + 1 < hs:
            yy = (y + 1) * A.DOWN
            if shape_full['kind'] == 'poly':
                xl_f, xr_f = x_on_line(shape_full['left'], yy), x_on_line(shape_full['right'], yy)
            else:
                hw = trap_half_width(shape_full, yy); xl_f, xr_f = shape_full['cx'] - hw, shape_full['cx'] + hw
            xl = int(max(0, min(ws - 1, xl_f / A.DOWN)))
            xr = int(max(0, min(ws - 1, xr_f / A.DOWN)))
            if xr <= xl + 1:
                break
            if nb[y + 1, xl:xr].mean() <= A.R_PROFILE_MIN:
                break
            y += 1
        yb = min(h - 1, (y + 1) * A.DOWN)
        return {'key': 'y_bottom', 'value': float(yb), 'delta': float(yb - shape_full['y_bottom'])}
    return None


# ----------------------------------------------------------------------------- proposal per clip

def propose(row, frames, sandbox):
    gray, rgb = A.imread_gray_rgb(frames[0])
    h, w = gray.shape
    out = {'clip_id': row['clip_id'], 'path': row['path'], 'vendor': row.get('vendor', ''), 'expected': row.get('expected', 'propose'),
           'w': w, 'h': h, 'frames': len(frames), 'margin_px': A.MARGIN_PX, 'bound': None, 'keep': None, 'tier': None,
           'model': None, 'conf': 0.0, 'components': {}, 'ms': None, 't2ext': None, 'withheld': None}
    t0k = None
    if row['path'].lower().endswith('.dcm'):
        k0, i0 = A.tier_t0(os.path.join(sandbox, row['path']), gray.shape)
        if k0 is not None and i0.get('regions'):
            t0k = k0
            r0 = i0['regions'][0]
            out['bound'] = {'x0': r0['x0'], 'y0': r0['y0'], 'x1': r0['x1'], 'y1': r0['y1']}
            out['t0'] = {'ms': i0['ms'], 'regions': i0['regions']}
    keep, info = A.tier_t1(gray, bound=t0k)
    out['tier'] = 'T0T1' if t0k is not None else 'T1'
    out['ms'] = info.get('ms')
    comp_keys = ('fit_score', 'fit_iou', 'outside_blob_frac', 'masked_frac', 'interior_mean', 'interior_std', 'static_inside_frac',
                 'half_angle_deg', 'th_l_free_deg', 'th_r_free_deg', 'asym_deg', 'axis_tilt_deg', 'clipped_side', 'trap_side_angle_deg',
                 'trap_seed', 'fan_sym_score', 'trap_sym_score', 'rect_score', 'fan_sym_iou', 'trap_sym_iou', 'rect_iou',
                 'bg_level', 'bg_frac', 'support_edges', 'top_edge_frac', 'trap_rows_both', 'trap_rows_one', 'union', 'union_cover', 'radii_refined', 'r_out_delta')
    out['components'] = {k: info[k] for k in comp_keys if k in info}
    out['conf'] = float(info.get('conf', 0.0) or 0.0)
    out['model'] = info.get('model')
    out['flag'] = info.get('flag')
    if keep is None or out['conf'] <= 0.0:
        out['withheld'] = info.get('withheld') or info.get('reason') or 'no_fit'
        return out, None
    p_small = info['params_small']
    out['keep'] = to_page_shape(p_small, w, h)
    try:
        out['t2ext'] = t2ext(frames, p_small, out['keep'], w, h)
    except Exception as e:  # evaluation-only; never fail the proposal
        out['t2ext'] = {'error': str(e)}
    return out, keep


# ----------------------------------------------------------------------------- pages

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>{clip} · automask bench</title>
<link rel="stylesheet" href="../_static/style.css?v={sv}"></head><body>
<header><h1><a href="../index.html">bench</a> / {clip}</h1><span class="muted">{w}×{h} · {frames} f · {vendor}</span><span class="stamp" id="stamp">{stamp}</span></header>{refcheck}
<div class="wrap">
  <div class="stage"><img id="frame" src="frame1.png"><canvas id="layer"></canvas></div>
  <div class="panel">
    <section><h2>Proposal</h2>
      <div class="kv"><b>tier</b><span>{tier}</span><b>model</b><span>{model}</span><b>conf</b><span>{conf}</span><b>ms</b><span>{ms}</span>{compkv}</div>
      {withheld_html}
    </section>
    <section id="ctlBox"><h2>Controls (addendum §2) — fix it, then save</h2>
      <div id="controls"></div>
      <div class="row"><label><input type="checkbox" id="showMask"> show mask as applied</label></div>
    </section>
    <section><h2>Verdict</h2>
      <div class="row">{verdict_buttons}</div>
      <textarea id="note" placeholder="note (optional): what is wrong, what you would draw"></textarea>
      <div id="prevNote" class="muted"></div>
      <div class="row"><button id="save">Save review</button></div><div id="status"></div>
    </section>
    <section class="muted">Tinted = proposed blank. White dashed = axis of symmetry; yellow dot = apex. Yellow dashed = DICOM region box (hard bound). Expected: <b>{expected}</b>.</section>
  </div>
</div>
<script>window.PROPOSAL = {json}; window.BENCH_VERSION = {stamp_json};</script>
<script src="../_static/shape.js?v={sv}"></script><script src="../_static/review.js?v={sv}"></script>
</body></html>"""


def static_version():
    """Cache-bust token: the newest mtime of the static assets, so a changed review.js can never be served stale."""
    return str(int(max(os.path.getmtime(os.path.join(HERE, 'bench_static', f)) for f in ('shape.js', 'review.js', 'style.css'))))


def write_page(out, clip_dir):
    comp = ''.join(f'<b>{k}</b><span>{v}</span>' for k, v in out['components'].items())
    if out['keep'] is None:
        wh = f'<p class="warn">No proposal — withheld ({out["withheld"]}). The canvas would be today\'s blank canvas.</p>'
        vb = ('<button data-verdict="withheld_ok">Correct — nothing to propose</button>'
              '<button data-verdict="withheld_miss">Wrong — there is a cone here</button>')
    else:
        wh = ''
        vb = ('<button data-verdict="right">Looks right</button><button data-verdict="adjusted">Adjusted (fixed with the controls)</button>'
              '<button data-verdict="wrong">Wrong — needs redraw</button>')
    sv = static_version()
    html = PAGE.format(refcheck=refcheck_html(out['clip_id']), clip=out['clip_id'], w=out['w'], h=out['h'], frames=out['frames'], vendor=out['vendor'] or '—',
                       tier=out['tier'], model=out['model'], conf=out['conf'], ms=out['ms'], compkv=comp,
                       withheld_html=wh, verdict_buttons=vb, expected=out['expected'], json=json.dumps(out),
                       stamp=BENCH_VERSION, stamp_json=json.dumps(BENCH_VERSION), sv=sv)
    open(os.path.join(clip_dir, 'review.html'), 'w').write(html)


INDEX = """<!doctype html><html><head><meta charset="utf-8"><title>automask bench</title><link rel="stylesheet" href="_static/style.css?v={sv}"></head>
<body><header><h1>automask bench</h1><span class="muted">{n} clips · built {built} · verdicts load from reviews.json</span><span class="stamp">{stamp}</span></header>
<table><thead><tr><th>clip</th><th>vendor</th><th>size</th><th>frames</th><th>expected</th><th>tier</th><th>model</th><th>half/side °</th><th>asym °</th><th>conf</th><th>withheld/flag</th><th>T2ext Δ</th><th>verdict</th><th>Δ depth</th></tr></thead>
<tbody>{rows}</tbody></table>
<script>
fetch('reviews.json').then(r=>r.ok?r.json():{{}}).then(all=>{{
  document.querySelectorAll('tr[data-clip]').forEach(tr=>{{const r=all[tr.dataset.clip]; if(!r) return;
    tr.querySelector('.v').innerHTML='<span class="pill '+r.verdict+'">'+r.verdict+'</span>'; tr.querySelector('.d').textContent=r.delta_px==null?'':(r.delta_px>=0?'+':'')+r.delta_px+' px';}});
}}).catch(()=>{{}});
</script></body></html>"""


def write_index(outs, bench_dir):
    rows = []
    for o in outs:
        t2 = o.get('t2ext') or {}
        rows.append(f'<tr data-clip="{o["clip_id"]}"><td><a href="{o["clip_id"]}/review.html">{o["clip_id"]}</a></td><td>{o["vendor"]}</td>'
                    f'<td>{o["w"]}×{o["h"]}</td><td>{o["frames"]}</td><td>{o["expected"]}</td><td>{o["tier"]}</td><td>{o["model"] or "—"}</td>'
                    f'<td>{o.get("components", {}).get("half_angle_deg", o.get("components", {}).get("trap_side_angle_deg", "—"))}</td><td>{o.get("components", {}).get("asym_deg", "—")}</td>'
                    f'<td>{o["conf"]}</td><td>{o.get("withheld") or o.get("flag") or ""}</td><td>{("%+.0f" % t2["delta"]) if t2.get("delta") is not None else "—"}</td><td class="v"></td><td class="d"></td></tr>')
    open(os.path.join(bench_dir, 'index.html'), 'w').write(INDEX.format(n=len(outs), built=datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), rows=''.join(rows), stamp=BENCH_VERSION, sv=static_version()))


# ----------------------------------------------------------------------------- server

def serve(bench_dir, port):
    reviews_path = os.path.join(bench_dir, 'reviews.json')

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=bench_dir, **k)

        def log_message(self, fmt, *args):
            if any('review' in str(a) for a in args):
                super().log_message(fmt, *args)

        def end_headers(self):
            # local-only bench: allow the sandbox app page (localhost:5001) to fetch fixtures for UI-driven tests
            self.send_header('Access-Control-Allow-Origin', '*')
            # pass-2 prep §1: nothing the bench serves may be cached by the browser
            self.send_header('Cache-Control', 'no-store, max-age=0'); self.send_header('Pragma', 'no-cache')
            super().end_headers()

        def do_POST(self):
            if self.path != '/review':
                self.send_error(404); return
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
            cid = body.get('clip_id')
            err = validate_review(body) if cid else 'missing clip_id'
            if err:
                self.send_response(400); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'ok': False, 'error': f'refused: {err}. Reload the page (stale bench?) — expected {BENCH_VERSION}'}).encode())
                super().log_message('POST /review REFUSED for %s: %s', cid, err); return
            if body.get('bench_version') != BENCH_VERSION:
                super().log_message('POST /review from a different bench version for %s: %r', cid, body.get('bench_version'))
            all_ = json.load(open(reviews_path)) if os.path.exists(reviews_path) else {}
            all_[cid] = body
            tmp = reviews_path + '.tmp'
            json.dump(all_, open(tmp, 'w'), indent=1); os.replace(tmp, reviews_path)
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"ok":true}')

    httpd = ThreadingHTTPServer(('127.0.0.1', port), H)
    print(f'bench: http://localhost:{port}/index.html   (Ctrl-C to stop; reviews → {reviews_path})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


# ----------------------------------------------------------------------------- report

def shape_full_mask(shape, w, h, bound=None):
    """Full-res keep mask for a page shape (fan / trap / rect / legacy poly) — Python twin of shape.js."""
    if shape['kind'] == 'fan':
        q = dict(shape)
        if 'half_angle' in q and q['half_angle'] is not None:
            q['th_l'], q['th_r'] = -q['half_angle'], q['half_angle']
        m = A.render_fan((h, w), q)
    elif shape['kind'] in ('trap', 'rect') and 'cx' in shape:
        m = A.render_trap((h, w), shape)
    elif shape['kind'] == 'poly':
        pts = poly_points(shape, shape['y_bottom'])
        m = np.zeros((h, w), np.uint8); cv2.fillPoly(m, [np.array(pts, np.int32).reshape(-1, 1, 2)], 1)
    else:
        m = A.render_fan((h, w), shape)
    if bound:
        box = np.zeros_like(m); box[bound['y0']:bound['y1'] + 1, bound['x0']:bound['x1'] + 1] = 1; m = m * box
    if A.MARGIN_PX > 0:
        m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * A.MARGIN_PX + 1, 2 * A.MARGIN_PX + 1)))
    return m


def poly_points(p, y_bottom):
    """shape.js polyPoints: fitted polygon at the fitted bottom; otherwise top chain + side lines at y_bottom."""
    fitted = p.get('y_bottom_fit', p['y_bottom'])
    if y_bottom is None:
        y_bottom = p['y_bottom']
    if abs(y_bottom - fitted) < 0.5:
        return p['pts']
    top = sorted([v for v in p['top_chain'] if v[1] < y_bottom], key=lambda v: v[0])
    right = [x_on_line(p['right'], y_bottom), y_bottom]; left = [x_on_line(p['left'], y_bottom), y_bottom]
    if not top:
        y_t = min(v[1] for v in p['top_chain']); return [[x_on_line(p['left'], y_t), y_t], [x_on_line(p['right'], y_t), y_t], right, left]
    return top + [right, left]


def with_depth(shape, value):
    q = dict(shape); q['r_out' if shape['kind'] == 'fan' else 'y_bottom'] = value; return q


def shapes_match(a, b, tol=1e-6):
    """Numeric equality of two shape dicts (JS serialises 160.0 as 160; string comparison flagged every review STALE)."""
    if not isinstance(a, dict) or not isinstance(b, dict) or a.get('kind') != b.get('kind'):
        return False
    keys = {k for k in set(a) | set(b) if k not in ('sym',)}
    for k in keys:
        va, vb = a.get(k), b.get(k)
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)) and not isinstance(va, bool):
            if abs(float(va) - float(vb)) > tol * max(1.0, abs(float(va))):
                return False
        elif isinstance(va, list) and isinstance(vb, list):
            if json.dumps(va) != json.dumps(vb):
                return False
        elif va != vb:
            return False
    return True


def top_width_px(shape):
    if not shape: return None
    if shape['kind'] == 'fan': return 2.0 * shape['r_in'] * math.sin(shape['half_angle'])
    if 'cx' in shape: return shape['w_top']
    return None


REQUIRED_REVIEW_KEYS = ('clip_id', 'verdict', 'reference', 'shape_fit', 'shape_user', 'deltas', 'bench_version')
REQUIRED_DELTA_KEYS = ('d_half_angle_deg', 'd_apex_px', 'd_top_px', 'd_depth_px')


def validate_review(body):
    """Loud validation for POST /review (pass-2 prep §1): a save without the full-parametric payload is refused."""
    missing = [k for k in REQUIRED_REVIEW_KEYS if k not in body]
    if body.get('verdict') in ('withheld_ok', 'withheld_miss'):
        missing = [k for k in missing if k not in ('shape_fit', 'shape_user', 'deltas')]
    if missing:
        return f'missing {missing}'
    if body.get('reference') != 'full-parametric':
        return f"reference is {body.get('reference')!r}, not 'full-parametric'"
    if body.get('deltas') is not None:
        dm = [k for k in REQUIRED_DELTA_KEYS if k not in body['deltas']]
        if dm:
            return f'deltas missing {dm}'
    return None


def shape_deltas(fit, user):
    """Python twin of shape.js deltas(): Δ half-angle (deg), Δ apex (px), Δ top (px), Δ depth (px)."""
    if not fit or not user or fit.get('kind') != user.get('kind'):
        return None
    if fit['kind'] == 'fan':
        return {'d_half_angle_deg': math.degrees(user['half_angle'] - fit['half_angle']) if 'half_angle' in fit and 'half_angle' in user else None,
                'd_apex_px': math.hypot(user['ax'] - fit['ax'], user['ay'] - fit['ay']), 'd_top_px': user['r_in'] - fit['r_in'], 'd_depth_px': user['r_out'] - fit['r_out']}
    if 'cx' in fit:
        return {'d_half_angle_deg': trap_side_angle_deg(user) - trap_side_angle_deg(fit), 'd_apex_px': math.hypot(user['cx'] - fit['cx'], user['y_top'] - fit['y_top']),
                'd_top_px': user['y_top'] - fit['y_top'], 'd_depth_px': user['y_bottom'] - fit['y_bottom']}
    return {'d_half_angle_deg': None, 'd_apex_px': None, 'd_top_px': None, 'd_depth_px': user['y_bottom'] - fit['y_bottom']}


KICKOFF_CLIPS = ['Normal_Lung_sliding', 'kidney_copy', 'bfly_z2b', 'sector_unknown_vendor', 'ge_e9_2124113685', 'ge_e9_4351124429', 'bfly_frame_000092']
# the kickoff's seven: reference clip, Kidney, a Butterfly export, [cart-vendor clip with a scale bar — none supplied yet;
# the sector clip stands in], single-frame DICOM, multiframe DICOM, PNG still


SANDBOX_ROOT = DEFAULT_SANDBOX


def refcheck_set():
    """Pass 3 §3: references Andre has been asked to confirm or redo (split.json → reference_check); excluded from counts."""
    sp = os.path.join(SANDBOX_ROOT, 'split.json')
    return json.load(open(sp)).get('reference_check', {}) if os.path.exists(sp) else {}


def refcheck_html(clip):
    rc = refcheck_set()
    if clip not in rc:
        return ''
    return ('<div style="background:#7a2e2e;color:#fff;padding:8px 12px;margin:8px 0;border-radius:4px"><b>reference check</b> — '
            + rc[clip].replace('<', '&lt;') + ' Please confirm the saved shape or redo it with the controls.</div>')


def t2ext_by_half(t2cand, split_path):
    """Pass 2 §4: the T2ext agreement reported on the tune half and the test half separately (split.json)."""
    if not os.path.exists(split_path):
        return []
    sp = json.load(open(split_path)); out = []
    for half in ('tune', 'test', 'blocked'):
        ids = set(sp.get(half, [])); cs = [c for c in t2cand if c['clip'] in ids]
        if cs:
            ok = [c for c in cs if c['agree'] <= 10]
            out.append(f'  · {half} half: {len(ok)} / {len(cs)} within 10 px ({100 * len(ok) / len(cs):.0f} %) — ' + ', '.join(f"{c['clip']} {c['agree']:.0f} px" for c in cs))
    return out


def report(bench_dir, results_dir):
    """Track 0 table, reference: FULL-PARAMETRIC (addendum §2). A review carries the whole corrected shape; the
    fitted shape is scored against it with the spike's score() (IoU / leak / over-blank / _core6) plus the four
    parameter deltas. Reviews from before the symmetric models (no shape_user, or a shape_fit that no longer
    matches the current proposal) are listed as STALE and not scored."""
    reviews = json.load(open(os.path.join(bench_dir, 'reviews.json'))) if os.path.exists(os.path.join(bench_dir, 'reviews.json')) else {}
    rows = []
    for pj in sorted(glob.glob(os.path.join(bench_dir, '*', 'proposal.json'))):
        o = json.load(open(pj)); r = reviews.get(o['clip_id'], {}); t2 = o.get('t2ext') or {}
        sc, d, stale, fit_changed = {}, None, False, False
        if r:
            if r.get('reference') != 'full-parametric' or not r.get('shape_user'):
                stale = True
            elif o.get('keep'):
                fit_changed = not shapes_match(r.get('shape_fit'), o.get('keep'))
                fitted = shape_full_mask(o['keep'], o['w'], o['h'], o.get('bound'))
                ref = shape_full_mask(r['shape_user'], o['w'], o['h'], o.get('bound'))
                sc = A.score(fitted, ref); d = shape_deltas(o['keep'], r['shape_user'])
        dt = t2.get('delta')
        du = d['d_depth_px'] if d else None
        d_wtop = (top_width_px(r['shape_user']) - top_width_px(o['keep'])) if (d and top_width_px(o.get('keep')) is not None) else None
        small_geom = d is not None and (d.get('d_half_angle_deg') is None or abs(d['d_half_angle_deg']) < 1.0) and (d.get('d_apex_px') is None or d['d_apex_px'] < 4)
        agree = (abs(du - dt) if (du is not None and dt is not None and small_geom) else None)
        comp = o.get('components', {})
        rows.append({'clip': o['clip_id'], 'vendor': o['vendor'], 'expected': o['expected'], 'tier': o['tier'], 'model': o['model'] or '—',
                     'half': comp.get('half_angle_deg', comp.get('trap_side_angle_deg')), 'asym': comp.get('asym_deg'), 'tilt': comp.get('axis_tilt_deg'),
                     'conf': o['conf'], 'withheld': o.get('withheld') or '', 'flag': o.get('flag') or '',
                     'verdict': ('STALE: ' if stale else '') + r.get('verdict', '') + (' (fit changed since)' if fit_changed else ''),
                     'd_half': d.get('d_half_angle_deg') if d else None, 'd_apex': d.get('d_apex_px') if d else None, 'd_top': d.get('d_top_px') if d else None, 'd_wtop': d_wtop, 'd_depth': du,
                     'd_t2ext': dt, 'agree': agree,
                     'iou': sc.get('iou'), 'leak': sc.get('leak'), 'over': sc.get('over_blank'), 'leak6': sc.get('leak_core6'), 'over6': sc.get('over_core6'),
                     'note': r.get('note', '')})
    f = lambda v, fmt='{}': '' if v is None else fmt.format(v)
    lines = [f'**reference: full-parametric, absolute** (the corrected shape Andre saved with the controls is scored against the CURRENT fit even when the fit has changed since — such rows are marked) — {BENCH_VERSION}', '',
             '| clip | vendor | expected | tier | model | half/side ° | asym ° | tilt ° | conf | withheld/flag | verdict | Δ half ° | Δ apex px | Δ top px | Δ w_top px | Δ depth px | Δ T2ext px | \|Δu−Δt2\| | IoU fit vs user | leak | over-blank | leak_core6 | over_core6 | note |',
             '|' + '---|' * 24]
    for c in rows:
        lines.append('| ' + ' | '.join([c['clip'], c['vendor'], c['expected'], c['tier'], c['model'], f(c['half'], '{:.1f}'), f(c['asym'], '{:+.1f}'), f(c['tilt'], '{:+.1f}'),
                                         f(c['conf'], '{:.3f}'), (c['withheld'] or c['flag']), c['verdict'], f(c['d_half'], '{:+.1f}'), f(c['d_apex'], '{:.0f}'), f(c['d_top'], '{:+.0f}'),
                                         f(c['d_wtop'], '{:+.0f}'), f(c['d_depth'], '{:+.0f}'), f(c['d_t2ext'], '{:+.0f}'), f(c['agree'], '{:.0f}'), f(c['iou'], '{:.4f}'), f(c['leak'], '{:.4f}'),
                                         f(c['over'], '{:.4f}'), f(c['leak6'], '{:.4f}'), f(c['over6'], '{:.4f}'), c['note'].replace('|', '/')]) + ' |')
    pos = [c for c in rows if c['expected'] == 'propose']; neg = [c for c in rows if c['expected'] == 'withhold']
    cnt = lambda vs, key: sum(1 for c in vs if c['verdict'] == key)
    rc = refcheck_set()
    scored = [c for c in pos if c['iou'] is not None and c['clip'] not in rc]
    tol = [c for c in scored if c['iou'] >= 0.90 and c['leak6'] <= 0.01]
    kick = [c for c in rows if c['clip'] in KICKOFF_CLIPS]; kick_tol = [c for c in kick if c['iou'] is not None and c['iou'] >= 0.90 and c['leak6'] <= 0.01]
    t2cand = [c for c in rows if (c['d_t2ext'] or 0) > 2 and c['agree'] is not None]
    summary = ['',
               f'**Positive clips:** {len(pos)} — right {cnt(pos, "right")}, adjusted {cnt(pos, "adjusted")}, wrong {cnt(pos, "wrong")}, withheld-miss {cnt(pos, "withheld_miss")}, stale {sum(1 for c in pos if c["verdict"].startswith("STALE"))}, unreviewed {sum(1 for c in pos if not c["verdict"])}',
               f'**Negative clips:** {len(neg)} — withheld: ' + ', '.join(f'{c["clip"]} ({c["withheld"] or "PROPOSED — not withheld"})' for c in neg),
               f'**Accept-or-controls-only (right + adjusted) / positive:** {cnt(pos, "right") + cnt(pos, "adjusted")} / {len(pos)}',
               (f'**Reference check (excluded from the counts below until Andre confirms):** ' + ', '.join(f'{c} — {rc[c]}' for c in rc) if rc else '**Reference check:** none'),
               f'**Tolerant rule with the FITTED parameters (IoU ≥ 0.90 & leak_core6 ≤ 1 %) among reviewed positives:** {len(tol)} / {len(scored)}   ·   kickoff clips: {len(kick_tol)} / {len(kick)} ({", ".join(KICKOFF_CLIPS)})',
               f'**T2ext question:** of {len(t2cand)} reviewed clips with a > 2 px T2ext suggestion and small angle/apex deltas, the user depth is within 10 px of T2ext on {sum(1 for c in t2cand if c["agree"] <= 10)}',
               *t2ext_by_half(t2cand, os.path.join(os.path.dirname(bench_dir), 'split.json')),
               f'**Half-angle diagnostics over all fits:** |asym| median {np.median([abs(c["asym"]) for c in rows if c["asym"] is not None]) if any(c["asym"] is not None for c in rows) else float("nan"):.1f}°, max {max([abs(c["asym"]) for c in rows if c["asym"] is not None], default=float("nan")):.1f}°; |tilt| median {np.median([abs(c["tilt"]) for c in rows if c["tilt"] is not None]) if any(c["tilt"] is not None for c in rows) else float("nan"):.1f}°']
    md = '\n'.join(lines + summary) + '\n'
    print(md)
    os.makedirs(results_dir, exist_ok=True)
    out = os.path.join(results_dir, datetime.datetime.now().strftime('%Y-%m-%d_%H%M') + '_bench.md')
    open(out, 'w').write(md); print('wrote', out)


# ----------------------------------------------------------------------------- ingest

def probe_file(p):
    ext = os.path.splitext(p)[1].lower()
    if ext == '.dcm':
        import pydicom
        ds = pydicom.dcmread(p, stop_before_pixels=True)
        return 'dicom', int(ds.get('NumberOfFrames', 1)), int(ds.Columns), int(ds.Rows)
    if ext in STILL_EXT:
        im = cv2.imread(p, cv2.IMREAD_UNCHANGED); return 'still_' + ext.lstrip('.'), 1, im.shape[1], im.shape[0]
    out = subprocess.run([os.path.join(os.path.dirname(ffmpeg_bin()), 'ffprobe'), '-v', 'error', '-select_streams', 'v:0', '-count_frames',
                          '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', p], capture_output=True, text=True).stdout
    st = json.loads(out)['streams'][0]
    return ext.lstrip('.'), int(st.get('nb_read_frames', 0)), int(st['width']), int(st['height'])


def ingest(sandbox, manifest):
    """Manifest rows for files Andre placed under sandbox/clips/** that have none. Fills only what the file says
    (vendor = folder, format, frames, w, h) and expected=propose (withhold for negative/); probe / mode / depth /
    furniture / phi stay blank for Andre. Never touches existing rows."""
    rows = list(csv.DictReader(open(manifest))); fields = list(rows[0].keys())
    have = {os.path.normpath(r['path']) for r in rows}; ids = {r['clip_id'] for r in rows}
    added = []
    for p in sorted(glob.glob(os.path.join(sandbox, 'clips', '*', '*'))):
        rel = os.path.relpath(p, sandbox)
        if os.path.basename(p).startswith('.') or os.path.normpath(rel) in have: continue
        ext = os.path.splitext(p)[1].lower()
        if ext not in VIDEO_EXT | STILL_EXT | {'.dcm'}: print('skip (type)', rel); continue
        vendor = rel.split(os.sep)[1]
        base = re.sub(r'[^A-Za-z0-9]+', '_', os.path.splitext(os.path.basename(p))[0]).strip('_')
        cid = f'{vendor}_{base}' if vendor not in ('stills', 'other', 'negative') else base
        while cid in ids: cid += '_x'
        try:
            fmt, n, w, h = probe_file(p)
        except Exception as e:
            print('skip (probe failed)', rel, e); continue
        row = {k: '' for k in fields}
        row.update(clip_id=cid, path=rel, vendor='' if vendor in ('stills', 'other', 'negative') else vendor, format=fmt, frames=n, w=w, h=h,
                   expected='withhold' if vendor == 'negative' else 'propose', notes='added by bench.py --ingest ' + datetime.date.today().isoformat() + '; probe/mode/depth for Andre')
        rows.append(row); ids.add(cid); added.append(row)
        print(f'+ {cid:34s} {rel}  {fmt} {n}f {w}x{h}')
    with open(manifest, 'w', newline='') as f:
        wr = csv.DictWriter(f, fieldnames=fields); wr.writeheader(); wr.writerows(rows)
    print(f'{len(added)} rows added → {manifest}')


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sandbox', default=DEFAULT_SANDBOX)
    ap.add_argument('--manifest', default=None)
    ap.add_argument('--clips', default=None)
    ap.add_argument('--rebuild', action='store_true', help='re-extract frames and recompute proposals')
    ap.add_argument('--recompute', action='store_true', help='recompute proposals from the cached frames (after a constant change)')
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--ingest', action='store_true', help='add manifest rows for clips under sandbox/clips/** that have none (vendor from folder, dims/frames from the file)')
    ap.add_argument('--pages', action='store_true', help='rewrite every review.html + index from the existing proposal.json files (after a page/static change)')
    a = ap.parse_args()
    global SANDBOX_ROOT; SANDBOX_ROOT = os.path.abspath(a.sandbox)
    sandbox = os.path.abspath(a.sandbox)
    manifest = a.manifest or os.path.join(sandbox, 'manifest.csv')
    bench_dir = os.path.join(sandbox, 'bench'); os.makedirs(bench_dir, exist_ok=True)
    static_dst = os.path.join(bench_dir, '_static'); os.makedirs(static_dst, exist_ok=True)
    for f in ('shape.js', 'review.js', 'style.css'):
        shutil.copy(os.path.join(HERE, 'bench_static', f), static_dst)
    if a.report:
        report(bench_dir, os.path.join(sandbox, 'results')); return
    if a.ingest:
        ingest(sandbox, manifest); return
    if a.pages:
        outs = []
        for pj in sorted(glob.glob(os.path.join(bench_dir, '*', 'proposal.json'))):
            if os.path.basename(os.path.dirname(pj)).startswith('_'): continue
            o = json.load(open(pj)); write_page(o, os.path.dirname(pj)); outs.append(o)
        write_index(outs, bench_dir); print(f'{len(outs)} pages rewritten ({BENCH_VERSION})'); return
    rows = list(csv.DictReader(open(manifest)))
    want = set(a.clips.split(',')) if a.clips else None
    outs = []
    for row in rows:
        cid = row['clip_id']
        if want and cid not in want:
            pj = os.path.join(bench_dir, cid, 'proposal.json')
            if os.path.exists(pj):
                outs.append(json.load(open(pj)))
            continue
        clip_path = os.path.join(sandbox, row['path'])
        if not os.path.exists(clip_path):
            print(f'{cid:22s} MISSING {clip_path}'); continue
        clip_dir = os.path.join(bench_dir, cid); os.makedirs(clip_dir, exist_ok=True)
        pj = os.path.join(clip_dir, 'proposal.json')
        if os.path.exists(pj) and not a.rebuild and not a.recompute:
            outs.append(json.load(open(pj))); print(f'{cid:22s} cached'); continue
        t0 = time.time()
        frames = ensure_frames(clip_path, os.path.join(bench_dir, '_frames', cid), rebuild=a.rebuild)
        t_ex = time.time() - t0
        out, keep = propose(row, frames, sandbox)
        shutil.copy(frames[0], os.path.join(clip_dir, 'frame1.png'))
        json.dump(out, open(pj, 'w'), indent=1)
        write_page(out, clip_dir)
        outs.append(out)
        t2 = out.get('t2ext') or {}
        print(f'{cid:22s} {out["w"]}x{out["h"]} {out["frames"]:4d}f  extract {t_ex:5.1f}s  {out["tier"]:5s} {str(out["model"]):5s} conf={out["conf"]:.3f} '
              f'{("withheld:" + out["withheld"]) if out["withheld"] else ""} t2ext Δ={t2.get("delta")}')
    write_index(outs, bench_dir)
    print(f'{len(outs)} clips → {bench_dir}/index.html')
    if a.serve:
        serve(bench_dir, a.port)


if __name__ == '__main__':
    main()
