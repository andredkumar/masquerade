#!/usr/bin/env python3
"""
Tuning pass 1 — before → after comparison (addendum §5.2).

Compares the archived pre-symmetric proposals (sandbox/bench/_before_sym/<clip>/proposal.json) with the current
ones: per clip the model, the free-fit side angles (θ_L / θ_R) → symmetric half-angle, asym_deg, axis_tilt_deg,
conf, and whether the RENDERED keep-region changed (IoU before vs after). Writes
  sandbox/results/<date>_symmetric_pass.md
  sandbox/bench/_sym_before_after.png      contact sheet of the reviewed clips: old outline (red) vs new (green) on frame 1

    python3 sym_compare.py [--sandbox <dir>] [--clips a,b] [--sheet-clips reviewed|all]
"""
import argparse, glob, json, os, datetime, math
import numpy as np, cv2
HERE = os.path.dirname(os.path.abspath(__file__))
import sys; sys.path.insert(0, HERE)
import automask_spike as A
import bench as B

ap = argparse.ArgumentParser()
ap.add_argument('--sandbox', default=B.DEFAULT_SANDBOX)
ap.add_argument('--clips', default=None)
ap.add_argument('--sheet-clips', default='reviewed')
a = ap.parse_args()
SB = os.path.abspath(a.sandbox); bench = os.path.join(SB, 'bench'); before_dir = os.path.join(bench, '_before_sym')
old_reviews = {}
for f in glob.glob(os.path.join(before_dir, 'reviews_*.json')):
    old_reviews.update(json.load(open(f)))
want = set(a.clips.split(',')) if a.clips else None

rows, tiles = [], []
for pj in sorted(glob.glob(os.path.join(bench, '*', 'proposal.json'))):
    if os.path.basename(os.path.dirname(pj)).startswith('_'):
        continue
    new = json.load(open(pj)); cid = new['clip_id']
    if want and cid not in want:
        continue
    bp = os.path.join(before_dir, cid, 'proposal.json')
    old = json.load(open(bp)) if os.path.exists(bp) else None
    w, h = new['w'], new['h']
    m_new = B.shape_full_mask(new['keep'], w, h, new.get('bound')) if new.get('keep') else None
    m_old = B.shape_full_mask(old['keep'], w, h, old.get('bound')) if (old and old.get('keep')) else None
    same = None
    if m_new is not None and m_old is not None:
        same = A.iou(m_new, m_old)
    c = new.get('components', {})
    rows.append({'clip': cid, 'old_model': (old or {}).get('model') or ((old or {}).get('withheld') and f"withheld:{old['withheld']}") or '—',
                 'new_model': new.get('model') or (new.get('withheld') and f"withheld:{new['withheld']}") or '—',
                 'thL': c.get('th_l_free_deg'), 'thR': c.get('th_r_free_deg'), 'half': c.get('half_angle_deg', c.get('trap_side_angle_deg')),
                 'asym': c.get('asym_deg'), 'tilt': c.get('axis_tilt_deg'), 'conf_old': (old or {}).get('conf'), 'conf_new': new.get('conf'),
                 'iou_old_new': same, 'flag': new.get('flag') or '', 'old_verdict': old_reviews.get(cid, {}).get('verdict', ''),
                 'old_note': old_reviews.get(cid, {}).get('note', '')})
    reviewed = cid in old_reviews
    if (a.sheet_clips == 'all' or reviewed) and os.path.exists(os.path.join(bench, cid, 'frame1.png')):
        rgb = cv2.imread(os.path.join(bench, cid, 'frame1.png'), cv2.IMREAD_COLOR)
        if m_old is not None: A.outline(rgb, m_old, (0, 0, 255), 3)
        if m_new is not None: A.outline(rgb, m_new, (0, 255, 0), 3)
        sc = 360 / rgb.shape[0]; rgb = cv2.resize(rgb, (int(rgb.shape[1] * sc), 360))
        bar = np.zeros((26, rgb.shape[1], 3), np.uint8)
        cv2.putText(bar, f'{cid} {rows[-1]["old_model"]}->{rows[-1]["new_model"]} half={rows[-1]["half"]} asym={rows[-1]["asym"]} [{rows[-1]["old_verdict"]}]'[:70], (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1)
        tiles.append(np.concatenate([bar, rgb], 0))

f = lambda v, fmt='{}': '' if v is None else fmt.format(v)
lines = ['| clip | model before → after | θ_L free ° | θ_R free ° | half/side ° (sym) | asym ° | axis tilt ° | conf before → after | IoU(before, after) | rendered changed? | flag | first-review verdict | first-review note |',
         '|' + '---|' * 13]
for r in rows:
    changed = '' if r['iou_old_new'] is None else ('no (identical)' if r['iou_old_new'] > 0.999 else f'yes')
    lines.append('| ' + ' | '.join([r['clip'], f"{r['old_model']} → {r['new_model']}", f(r['thL'], '{:+.1f}'), f(r['thR'], '{:+.1f}'), f(r['half'], '{:.1f}'), f(r['asym'], '{:+.1f}'),
                                     f(r['tilt'], '{:+.1f}'), f"{f(r['conf_old'], '{:.3f}')} → {f(r['conf_new'], '{:.3f}')}", f(r['iou_old_new'], '{:.3f}'), changed, r['flag'],
                                     r['old_verdict'], r['old_note'].replace('|', '/')[:80]]) + ' |')
unchanged = [r['clip'] for r in rows if r['iou_old_new'] is not None and r['iou_old_new'] > 0.999]
asyms = [abs(r['asym']) for r in rows if r['asym'] is not None]; tilts = [abs(r['tilt']) for r in rows if r['tilt'] is not None]
lines += ['', f'**Rendered proposal unchanged by the symmetric fit:** {unchanged if unchanged else "none — every clip changed"}',
          f'**|asym_deg| (free-fit side-angle difference):** median {np.median(asyms):.1f}°, max {max(asyms):.1f}° over {len(asyms)} fits  ·  **|axis_tilt_deg|:** median {np.median(tilts):.1f}°, max {max(tilts):.1f}°' if asyms else '',
          f'**Models after:** ' + ', '.join(f'{m}: {sum(1 for r in rows if r["new_model"] == m)}' for m in sorted(set(r['new_model'] for r in rows)))]
md = '\n'.join(lines) + '\n'
print(md)
out = os.path.join(SB, 'results', datetime.datetime.now().strftime('%Y-%m-%d_%H%M') + '_symmetric_pass.md'); open(out, 'w').write(md); print('wrote', out)
if tiles:
    W = max(t.shape[1] for t in tiles); per = max(1, 2600 // W)
    tiles = [np.pad(t, ((0, 0), (0, W - t.shape[1]), (0, 0))) for t in tiles]
    rws = [np.concatenate(tiles[i:i + per], 1) for i in range(0, len(tiles), per)]
    rws = [np.pad(r, ((0, 0), (0, max(x.shape[1] for x in rws) - r.shape[1]), (0, 0))) for r in rws]
    sheet = np.concatenate(rws, 0)
    top = np.zeros((30, sheet.shape[1], 3), np.uint8); cv2.putText(top, 'symmetric pass: OLD outline red, NEW outline green (frame 1)', (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    cv2.imwrite(os.path.join(bench, '_sym_before_after.png'), np.concatenate([top, sheet], 0)); print('sheet', os.path.join(bench, '_sym_before_after.png'), len(tiles), 'tiles')
