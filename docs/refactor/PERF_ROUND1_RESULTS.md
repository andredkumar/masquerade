# Perf Round 1 — results from prod (fills §1–§3 and §5 of `PERF_ROUND1_REPORT.md`)

**Run:** 2026-08-30, prod (`3.136.48.97`), post-Round-2A deploy. One case so far:
`Normal Lung sliding 2.mp4` — 7.7 MB, **348 frames**, 1536×796, 43.1 fps (~8 s clip), template mask
applied once. Job `467975f7`. Cases A×3 / B-redo / C / D still to run, but this one job already
decides all three hypotheses.

## §2 `apply.env` — the box

| field | prod |
|---|---|
| `cpus` | **2** |
| `uv_threadpool` | default (4) |
| `sharp_concurrency` | **1** |
| `batch_size` / `volume_batch_size` | 12 / 8 |
| `node` | v20.19.4 |

**`sharp_concurrency: 1` is the single most important number in the log.** sharp deliberately
defaults its libvips threadpool to **1 on glibc Linux without jemalloc** (memory-fragmentation
guard). Every decode, mask, and encode in the apply loop goes through one thread, however many stacks
`Promise.all` throws at it. Batch size and stack size cannot matter on this box.

## §1 Wall-clock, this job

```
upload.multer_done ─┐
  ffprobe            116 ms
  first_frame        331 ms
  response_sent      510 ms after multer   ← upload feels done here
bg_extract.start
  first_frame_on_disk  1.9 s               ← Round 2A canvas opens here ✅
  done                45.6 s   348 frames  = 131 ms/frame   ← "the upload is much slower"
(user clicked Apply 2.5 s after ready)
apply.request
  staging_clean        0.02 s
  extract_all         19.5 s   348 frames  =  56 ms/frame   (ffmpeg single pass, re-decoding the upload)
  read_all             0.17 s
  mask loop           13.4 s   348 frames  =  39 ms/frame   (58 stacks all in flight, 1 libvips thread)
  write_all            0.10 s
apply.done            33.3 s
```
Upload-complete → masked frames on disk: **~81 s**, of which the mask arithmetic itself is ~4 s of
(overlapping) span and the rest is decode/encode and a redundant re-extraction.

## §3 Verdicts

| # | Hypothesis | Verdict | Deciding number |
|---|---|---|---|
| H1 | Apply-time re-extraction dominates | **CONFIRMED** | `extract_all` 19.5 s ÷ `apply.done` 33.3 s = **0.58** (threshold 0.40). Frames were already on disk in `temp_extracted/` from 28 s earlier. |
| H2 | Mask loop not actually parallel | **CONFIRMED (by mechanism)** | All 58 stacks launched at once (stack spans 4.9–8.5 s, all ending within ~1 s of each other), but `sharp_concurrency=1` means one thread does the pixel work. Per-frame `encode_ms` spans (0.5–3.6 s) are queue-wait, not work: real throughput is 39 ms/frame. Stack size is irrelevant here. |
| H3 | Encode ≫ mask arithmetic | **CONFIRMED** | `mask_ms` 5–25 ms vs `encode_ms` hundreds–thousands of ms per frame; ratio > 100× on spans. Even discounting queue-wait, the mask multiply is ~10 ms of a ~39 ms frame budget. |

Two further facts the numbers surface that no hypothesis predicted:

- **Background extraction (131 ms/frame) is 2.3× slower than the apply-time single-pass ffmpeg
  (56 ms/frame) on the same box, same file.** The 15-frame batch extractor pays a seek + spawn per
  batch; the single pass doesn't. That's the "upload is much slower" — 45 s of the 87 s you timed.
- **Everything is CPU-bound on ~1 effective core.** ffmpeg decode + PNG encode, then sharp decode +
  PNG encode, on a 2-vCPU instance with a 1-thread image library. The box is the ceiling. If it's a
  `t3.*`, CPU credits may also be throttling sustained work — check with
  `curl -s http://169.254.169.254/latest/meta-data/instance-type` on the server.

## §5 Biggest bucket — one sentence

**Apply re-extracts 348 frames it already has (19.5 s, 58%); the remaining 13 s is PNG decode/encode
serialized on a single libvips thread; the mask itself is noise.**

## Round 2A verification (from the same session)

Frame 1 on disk at 1.9 s; canvas opened during extraction; Apply gated then enabled; apply + download
completed. **T1–T5 pass.** The `URIError: Failed to decode param '/%c0'` in the error log is an
internet scanner probing the static handler — unrelated, harmless. `ANTHROPIC_API_KEY not set` is the
open 7A-4 item.

## What this changes about the Round 2 recommendation

Earlier I leaned toward "let ffmpeg do the masking in one pass over the video." The numbers say
otherwise: decoding the *video* is the expensive part (19.5 s), and the raw PNGs are already on disk.
The right move is to **stop decoding the video a second time and reuse `temp_extracted/`** — which
Round 2A made safe by construction (Apply can't fire before `ready`). Then unshackle sharp. See
`ROUND2B_PROPOSAL.md`.
