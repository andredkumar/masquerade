#!/usr/bin/env python3
"""Backlog item 5 repro input: an RGB (SamplesPerPixel=3, 8-bit, Explicit VR LE) multiframe DICOM built from a
real GE LOGIQ E9 colour-Doppler single-frame file. Frames cycle: original / R-B swapped / half intensity, so
frames are distinguishable and a correct extraction is visibly correct.

    python3 item5_make_synthetic_rgb_multiframe.py <rgb single-frame .dcm> [--frames N] [--planar 0|1] [--out path]

--planar 1 writes PlanarConfiguration=1 (RRR…GGG…BBB per frame) to exercise the de-interleave branch.
Default output /tmp/item5/rgb_multiframe_synthetic.dcm (planar 0, 3 frames). Patient fields are overwritten with
SYNTHETIC; pixel data is still the source image (PHI-adjacent — keep out of git)."""
import argparse, os, numpy as np, pydicom

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('--frames', type=int, default=3); ap.add_argument('--planar', type=int, default=0)
ap.add_argument('--out', default=None)
a = ap.parse_args()
ds = pydicom.dcmread(a.src)
assert int(ds.SamplesPerPixel) == 3 and int(ds.BitsAllocated) == 8, 'need an 8-bit RGB DICOM'
f0 = ds.pixel_array; variants = [f0, f0[:, :, [2, 1, 0]].copy(), (f0 // 2).astype(np.uint8)]
frames = [variants[i % 3] for i in range(a.frames)]
if a.planar == 1:
    frames = [np.ascontiguousarray(fr.transpose(2, 0, 1)) for fr in frames]   # (3, rows, cols) = RRR…GGG…BBB
    ds.PlanarConfiguration = 1
else:
    ds.PlanarConfiguration = 0
ds.NumberOfFrames = a.frames
ds.PixelData = np.stack(frames).tobytes()
ds.PatientName = 'SYNTHETIC^ITEM5'; ds.PatientID = 'ITEM5'
out = a.out or ('/tmp/item5/rgb_multiframe_synthetic.dcm' if a.planar == 0 and a.frames == 3 else f'/tmp/item5/rgb_synth_f{a.frames}_p{a.planar}.dcm')
os.makedirs(os.path.dirname(out), exist_ok=True)
ds.save_as(out, write_like_original=True)
print(out, ds.Rows, ds.Columns, f'x{a.frames} frames planar={a.planar}', ds.file_meta.TransferSyntaxUID, f'{os.path.getsize(out)/1e6:.0f} MB')
