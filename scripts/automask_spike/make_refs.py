#!/usr/bin/env python3
"""
Reference keep-region candidates for the spike (THROWAWAY).

No hand-drawn masks from Andre exist on this machine (uploads/ and temp_extracted/ are empty, no
apply artifacts), so the references are AGENT-AUTHORED:
  1. max-intensity projection over ALL frames of the clip (frame 1 alone for stills),
  2. the same support/fit pipeline as the proposer but at 2x (not 4x) downscale,
  3. for DICOM, intersected with the (0018,6011) region box,
  4. then visually verified on a verification sheet and hand-corrected in refs.json where wrong.
Step 4 is the human step; refs.json records what was changed and why.

Writes refs_candidates.json (full-res params) and out/_refs/<clip>.png verification sheets.
"""
import os, sys, json, glob, math
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__))
import automask_spike as A

FR = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), 'out', '_refs'); os.makedirs(OUT, exist_ok=True)
dicoms = json.load(open(os.path.join(os.path.dirname(__file__), 'dicoms.json')))
A.DOWN = 2
cands = {}
for clip in sorted(os.listdir(FR)):
    frames = sorted(glob.glob(os.path.join(FR, clip, 'frame_*.png')))
    if not frames: continue
    mx = None
    for f in frames:
        g, _ = A.imread_gray_rgb(f)
        mx = g if mx is None else np.maximum(mx, g)
    g1, rgb1 = A.imread_gray_rgb(frames[0])
    gs = A.small(mx)
    sup, blobs, _ = A.clean_support(gs)
    p, info = A.fit_fan(sup)
    entry = {'note': f"max-projection over {len(frames)} frames, fit at 2x, model={info.get('model')}"}
    if p is None:
        entry['keep'] = {'kind': 'none'}
    else:
        q = A.scale_params(p, 2)
        if q['kind'] == 'fan':
            entry['keep'] = {'kind': 'fan_px', 'ax': round(q['ax'], 1), 'ay': round(q['ay'], 1), 'r_in': round(q['r_in'], 1),
                             'r_out': round(q['r_out'], 1), 'th_l_deg': round(math.degrees(q['th_l']), 2), 'th_r_deg': round(math.degrees(q['th_r']), 2)}
        else:
            entry['keep'] = {'kind': 'poly_px', 'pts': [[int(x), int(y)] for x, y in q['pts']]}
    if clip in dicoms:
        import pydicom
        ds = pydicom.dcmread(dicoms[clip], stop_before_pixels=True)
        it = ds[(0x0018, 0x6011)].value[0]
        entry['clip_to_box'] = {'x0': int(it.RegionLocationMinX0), 'y0': int(it.RegionLocationMinY0),
                                'x1': int(it.RegionLocationMaxX1), 'y1': int(it.RegionLocationMaxY1)}
    cands[clip] = entry
    # verification sheet
    m, _ = A.load_ref({clip: entry}, clip, g1.shape) if entry['keep']['kind'] != 'none' else (None, None)
    if m is not None and 'clip_to_box' in entry:
        b = entry['clip_to_box']; box = np.zeros_like(m); box[b['y0']:b['y1'] + 1, b['x0']:b['x1'] + 1] = 1; m = m * box
    pan1 = cv2.cvtColor(mx, cv2.COLOR_GRAY2BGR); pan2 = rgb1.copy()
    if m is not None:
        A.outline(pan1, m, (0, 255, 0), 2); A.outline(pan2, m, (0, 255, 0), 2)
    h = 600; sc = h / pan1.shape[0]
    rs = lambda im: cv2.resize(im, (int(im.shape[1] * sc), h))
    sheet = np.concatenate([rs(pan1), rs(pan2)], 1)
    cv2.putText(sheet, f'{clip} REF candidate: left=max-proj, right=frame 1  {entry["note"]}', (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    cv2.imwrite(os.path.join(OUT, f'{clip}.png'), sheet)
    print(clip, json.dumps(entry))
json.dump(cands, open(os.path.join(os.path.dirname(__file__), 'refs_candidates.json'), 'w'), indent=1)
