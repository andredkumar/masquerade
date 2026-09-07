import os, sys, json, glob, numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__)); import automask_spike as A
FR=sys.argv[1]; refs=json.load(open('refs.json')); OUT='out/_refs_final'; os.makedirs(OUT,exist_ok=True)
for clip, r in refs.items():
    if clip.startswith('_') or r['keep']['kind']=='none': continue
    frames=sorted(glob.glob(f'{FR}/{clip}/frame_*.png')); mx=None
    for f in frames[::max(1,len(frames)//40)]:
        g,_=A.imread_gray_rgb(f); mx=g if mx is None else np.maximum(mx,g)
    g1,rgb1=A.imread_gray_rgb(frames[0]); m,_=A.load_ref(refs,clip,g1.shape)
    p1=cv2.cvtColor(mx,cv2.COLOR_GRAY2BGR); p2=rgb1.copy(); A.outline(p1,m,(0,255,0),2); A.outline(p2,m,(0,255,0),2)
    h=600; sc=h/p1.shape[0]; rs=lambda im: cv2.resize(im,(int(im.shape[1]*sc),h))
    sheet=np.concatenate([rs(p1),rs(p2)],1); cv2.putText(sheet,f'{clip} FINAL REF (green): left=max-proj right=frame1',(8,24),cv2.FONT_HERSHEY_SIMPLEX,0.6,(0,255,255),2)
    cv2.imwrite(f'{OUT}/{clip}.png',sheet)
print('ok')
