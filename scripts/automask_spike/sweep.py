"""Parameter sensitivity sweep for T1 / T2max (THROWAWAY). Prints a compact table."""
import os, sys, json, glob, itertools, numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__)); import automask_spike as A
FR = sys.argv[1]; refs = json.load(open('refs.json'))
clips = [c for c in refs if not c.startswith('_') and refs[c]['keep']['kind'] != 'none']
data = {}
for c in clips:
    fr = sorted(glob.glob(f'{FR}/{c}/frame_*.png')); g, _ = A.imread_gray_rgb(fr[0])
    data[c] = (fr, g, A.load_ref(refs, c, g.shape)[0])
def run(T_LOW, D_MIN, K_DENS, K_CLOSE):
    A.T_LOW, A.D_MIN, A.K_DENS, A.K_CLOSE = T_LOW, D_MIN, K_DENS, K_CLOSE
    out = {'T1': [], 'T2max': []}
    for c, (fr, g, ref) in data.items():
        k1, i1 = A.tier_t1(g)
        s1 = A.score(k1, ref) if (k1 is not None and i1.get('conf', 0) > 0) else {'iou': 0, 'leak': 0, 'over_blank': 1}
        out['T1'].append((c, s1, i1.get('conf', 0)))
        if len(fr) > 1:
            o = A.tier_t2(fr, g); r2 = o['t2max']
            s2 = A.score(r2['keep'], ref) if ('keep' in r2 and r2.get('conf', 0) > 0) else {'iou': 0, 'leak': 0, 'over_blank': 1}
            out['T2max'].append((c, s2, r2.get('conf', 0)))
    return out
def summ(rows):
    ious = [s['iou'] for _, s, _ in rows]; leaks = [s['leak'] for _, s, _ in rows]
    acc = sum(1 for _, s, _ in rows if s['iou'] >= 0.97 and s['leak'] <= 0.005)
    tol = sum(1 for _, s, _ in rows if s['iou'] >= 0.90 and s.get('leak_core6', 1) <= 0.01)
    return f"meanIoU={np.mean(ious):.3f} minIoU={min(ious):.3f} maxLeak={max(leaks):.3f} strict={acc} tolerant={tol}/{len(rows)}"
print('T_LOW D_MIN K_DENS K_CLOSE | T1 | T2max')
for T_LOW, D_MIN, K_DENS, K_CLOSE in itertools.product([2, 3, 5], [0.25, 0.35, 0.45], [11], [15]):
    o = run(T_LOW, D_MIN, K_DENS, K_CLOSE)
    print(f'{T_LOW} {D_MIN} {K_DENS} {K_CLOSE} | {summ(o["T1"])} | {summ(o["T2max"])}', flush=True)
