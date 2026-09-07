#!/usr/bin/env python3
"""
Pass-2 tuning harness (AUTOMASK_PASS2_REVISED.md §1/§5).

Andre's saved shapes (sandbox/bench/reviews.json → shape_user) are ABSOLUTE references. This runs the proposer
on frame 1 of every reviewed positive with a chosen rule set and scores against them — no bench pages, no
re-review. The tune half is what we look at while changing rules; the test half is scored the same way but only
reported at the end (no peeking: use --half tune while iterating).

  python3 tune.py --half tune                      # current RULES, tune half
  python3 tune.py --half tune --baseline           # all pass-2 rules off (pass-1 fit)
  python3 tune.py --half tune --ablate             # each rule alone, which one moved which clip
  python3 tune.py --half test                      # the final look, once
  python3 tune.py --half all --json out.json        # everything, machine-readable

Columns: family, model, Δ half °, Δ apex px, Δ top px, Δ arc px, Δ w_top px, Δ depth px — all Andre − fit, so a POSITIVE
Δ top means Andre put the top LOWER than the fit. For fans Δ top is Δ r_in (the page's control) and Δ arc is the
absolute move of the arc's lowest point (ay + r_in) — the visible top edge; a fan whose apex Andre nudged 8 px down
with the arc left in place shows Δ top −8 and Δ arc 0. For trap/rect Δ arc = Δ top. IoU / leak / over / _core6 vs
Andre's shape, tolerant pass (IoU ≥ 0.90 & leak_core6 ≤ 1 %).
"""
import argparse, glob, json, math, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import automask_spike as A
import bench as B

ap = argparse.ArgumentParser()
ap.add_argument('--sandbox', default=B.DEFAULT_SANDBOX)
ap.add_argument('--half', default='tune', choices=['tune', 'test', 'all', 'blocked', 'reference_check'])
ap.add_argument('--baseline', action='store_true', help='all pass-2 rules off')
ap.add_argument('--ablate', action='store_true', help='run baseline + each rule alone + all rules; attribute per clip')
ap.add_argument('--json', default=None)
ap.add_argument('--quiet', action='store_true')
a = ap.parse_args()
SB = os.path.abspath(a.sandbox)
reviews = json.load(open(os.path.join(SB, 'bench', 'reviews.json')))
split = json.load(open(os.path.join(SB, 'split.json')))
fam_of = split['family_of']
REF_CHECK = set(split.get('reference_check', {}))            # pass 3: doubtful references, excluded from every count until Andre confirms
_h = {'tune': split['tune'], 'test': split['test'], 'all': split['tune'] + split['test'], 'blocked': split.get('blocked', []), 'reference_check': sorted(REF_CHECK)}
clips = [c for c in _h[a.half] if a.half == 'reference_check' or c not in REF_CHECK]
# §2 controls-only estimator: tolerant, OR IoU ≥ 0.80 & leak_core6 ≤ 1 % & exactly ONE parameter beyond tolerance
TOL = {'half': 1.5, 'apex': 8.0, 'top': 8.0, 'w_top': 8.0, 'depth': 12.0}


def run_clip(cid):
    r = reviews[cid]; ref_shape = r['shape_user']
    pj = os.path.join(SB, 'bench', cid, 'proposal.json'); o = json.load(open(pj))
    frames = sorted(glob.glob(os.path.join(SB, 'bench', '_frames', cid, 'frame_*.png')))
    g, _ = A.imread_gray_rgb(frames[0]); h, w = g.shape
    bound = None
    if o.get('bound'):
        b = o['bound']; bound = np.zeros((h, w), np.uint8); bound[b['y0']:b['y1'] + 1, b['x0']:b['x1'] + 1] = 1
    keep, info = A.tier_t1(g, bound=bound)
    ref = B.shape_full_mask(ref_shape, w, h, o.get('bound'))
    out = {'clip': cid, 'family': fam_of.get(cid, '?'), 'model': info.get('model'), 'conf': info.get('conf'), 'withheld': info.get('withheld'),
           'flag': info.get('flag'), 'rules': [k for k in ('rin_rule', 't0_depth') if k in info]}
    if keep is None:
        out.update(iou=None, leak=None, over=None, leak6=None, over6=None, tol=False, controls_only=False, beyond=['withheld']); return out
    sc = A.score(keep, ref)
    page = B.to_page_shape(info['params_small'], w, h)
    d = B.shape_deltas(page, ref_shape) or {}
    wt = B.top_width_px(ref_shape); wf = B.top_width_px(page)
    if page['kind'] == 'fan' and ref_shape['kind'] == 'fan':
        d_arc = (ref_shape['ay'] + ref_shape['r_in']) - (page['ay'] + page['r_in'])
    else:
        d_arc = d.get('d_top_px')
    out.update(d_arc=d_arc, iou=sc['iou'], leak=sc['leak'], over=sc['over_blank'], leak6=sc['leak_core6'], over6=sc['over_core6'],
               tol=(sc['iou'] >= 0.90 and sc['leak_core6'] <= 0.01),
               d_half=d.get('d_half_angle_deg'), d_apex=d.get('d_apex_px'), d_top=d.get('d_top_px'), d_depth=d.get('d_depth_px'),
               d_wtop=(wt - wf) if (wt is not None and wf is not None) else None, kind_match=(page['kind'] == ref_shape['kind']))
    # §2 estimator — which parameters lie beyond the one-slider tolerance
    vals = {'half': out['d_half'], 'apex': out['d_apex'], 'top': d_arc if page['kind'] == 'fan' else out['d_top'], 'w_top': out['d_wtop'], 'depth': out['d_depth']}
    beyond = [k for k, v in vals.items() if v is not None and abs(v) > TOL[k]]
    if not out['kind_match']: beyond = ['model'] + beyond
    out['beyond'] = beyond
    out['controls_only'] = bool(out['tol'] or (sc['iou'] >= 0.80 and sc['leak_core6'] <= 0.01 and len(beyond) == 1))
    return out


def table(rows, title):
    f = lambda v, fmt='{}': '—' if v is None else fmt.format(v)
    lines = [f'### {title}', '', '| clip | family | model | conf | Δ half ° | Δ apex px | Δ top px | Δ arc px | Δ w_top px | Δ depth px | IoU | leak | over | leak_core6 | over_core6 | tolerant | controls-only (beyond) | rules |', '|' + '---|' * 18]
    for r in rows:
        lines.append('| ' + ' | '.join([r['clip'], r['family'], str(r['model']), f(r['conf'], '{:.2f}'), f(r.get('d_half'), '{:+.1f}'), f(r.get('d_apex'), '{:.0f}'), f(r.get('d_top'), '{:+.0f}'), f(r.get('d_arc'), '{:+.0f}'),
                                         f(r.get('d_wtop'), '{:+.0f}'), f(r.get('d_depth'), '{:+.0f}'), f(r['iou'], '{:.4f}'), f(r['leak'], '{:.4f}'), f(r['over'], '{:.4f}'), f(r['leak6'], '{:.4f}'), f(r['over6'], '{:.4f}'),
                                         '✅' if r['tol'] else ('withheld' if r['withheld'] else '✗'),
                                         ('✅' if r.get('controls_only') else '✗ redraw') + (' (' + ', '.join(r.get('beyond', [])) + ')' if r.get('beyond') else ''), ','.join(r.get('rules', []))]) + ' |')
    # family summary
    fams = sorted(set(r['family'] for r in rows))
    lines += ['', '| family | n | tolerant | controls-only | IoU median | median \\|Δ top\\| px | median \\|Δ arc\\| px | median \\|Δ w_top\\| px | median \\|Δ half\\| ° | median Δ depth px | leak_core6 > 1 % |', '|' + '---|' * 11]
    def med(vals): vals = [v for v in vals if v is not None]; return f'{np.median(vals):.1f}' if vals else '—'
    for fm in fams:
        rs = [r for r in rows if r['family'] == fm]
        lines.append(f"| {fm} | {len(rs)} | {sum(r['tol'] for r in rs)}/{len(rs)} | {sum(1 for r in rs if r.get('controls_only'))}/{len(rs)} | {med([r['iou'] for r in rs])} | {med([abs(r['d_top']) for r in rs if r.get('d_top') is not None])} | {med([abs(r['d_arc']) for r in rs if r.get('d_arc') is not None])} | {med([abs(r['d_wtop']) for r in rs if r.get('d_wtop') is not None])} | {med([abs(r['d_half']) for r in rs if r.get('d_half') is not None])} | {med([r['d_depth'] for r in rs if r.get('d_depth') is not None])} | {sum(1 for r in rs if (r['leak6'] or 0) > 0.01)} |")
    tol = sum(r['tol'] for r in rows); n = len(rows); co = sum(1 for r in rows if r.get('controls_only'))
    lines += ['', f'**tolerant (IoU ≥ 0.90 & leak_core6 ≤ 1 %) with the fitted parameters: {tol}/{n} = {100 * tol / max(1, n):.0f} %**  ·  families below 50 %: '
              + (', '.join(fm for fm in fams if sum(r['tol'] for r in rows if r['family'] == fm) * 2 < sum(1 for r in rows if r['family'] == fm)) or 'none'),
              f'**controls-only fixable (§2 estimator: tolerant, or IoU ≥ 0.80 & leak_core6 ≤ 1 % & one parameter beyond half ±1.5° / apex 8 / top 8 / w_top 8 / depth 12 px): {co}/{n} = {100 * co / max(1, n):.0f} %**'
              + (f'  ·  excluded pending reference check: {", ".join(sorted(REF_CHECK))}' if REF_CHECK and a.half != 'reference_check' else '')]
    return '\n'.join(lines)


def run_all(clips):
    return [run_clip(c) for c in clips]


results = {}
if a.baseline or a.ablate:
    saved = dict(A.RULES)
    for k in A.RULES: A.RULES[k] = False
    results['baseline'] = run_all(clips)
    A.RULES.update(saved)
if a.ablate:
    saved = dict(A.RULES)
    for rule in saved:
        for k in A.RULES: A.RULES[k] = (k == rule)
        results['only:' + rule] = run_all(clips)
    A.RULES.update(saved)
if not a.baseline:
    results['current'] = run_all(clips)

out_md = []
for name, rows in results.items():
    out_md.append(table(rows, f'{a.half} half — rules: {name}  ({dict(A.RULES) if name == "current" else name})'))
if a.ablate:
    base = {r['clip']: r for r in results['baseline']}; cur = {r['clip']: r for r in results['current']}
    lines = ['### attribution (tune half): which single rule moves each clip most (Δ IoU vs baseline), and the all-rules result', '', '| clip | baseline IoU | ' + ' | '.join(k for k in A.RULES) + ' | all rules | tolerant before → after |', '|' + '---|' * (4 + len(A.RULES))]
    for c in clips:
        b = base[c]; row = [c, f"{b['iou']:.3f}" if b['iou'] is not None else '—']
        for k in A.RULES:
            r = {x['clip']: x for x in results['only:' + k]}[c]
            row.append(('' if r['iou'] is None or b['iou'] is None else f"{r['iou'] - b['iou']:+.3f}"))
        row.append(f"{cur[c]['iou']:.3f}" if cur[c]['iou'] is not None else '—')
        row.append(f"{'✅' if b['tol'] else '✗'} → {'✅' if cur[c]['tol'] else '✗'}")
        lines.append('| ' + ' | '.join(row) + ' |')
    fell = [c for c in clips if base[c]['tol'] and not cur[c]['tol']]
    lines += ['', f'**Regression rule (no tune clip that passed may fall):** {"none fell" if not fell else "FELL: " + ", ".join(fell)}']
    out_md.append('\n'.join(lines))
md = '\n\n'.join(out_md) + '\n'
if not a.quiet: print(md)
if a.json:
    json.dump({'half': a.half, 'rules': A.RULES, 'results': results}, open(a.json, 'w'), indent=1)
    print('wrote', a.json)
