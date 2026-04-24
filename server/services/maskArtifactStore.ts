/**
 * In-memory store for per-label mask/overlay base64 artifacts.
 *
 * These blobs are intentionally NEVER persisted to the database. A single 512x512
 * PNG mask encodes to ~5-50 KB of base64; across many frames and labels this was
 * blowing through Neon's data transfer quota. They only need to live for the
 * duration of a session (from the Run click until the user downloads).
 *
 * If the Node process restarts, artifacts are lost and downloads will omit the
 * masks/ and overlays/ subfolders — the metadata (manifest.json, confidence
 * scores, bbox) still works because it's kept in the DB.
 */

export interface LabelArtifacts {
  /** First-frame mask PNG as base64 (used as single-frame fallback) */
  maskB64?: string;
  /** First-frame overlay PNG as base64 */
  overlayB64?: string;
  /** Per-frame artifacts, keyed by frame index */
  frameResults?: Record<number, {
    maskB64: string;
    overlayB64?: string;
  }>;
}

class MaskArtifactStore {
  private store = new Map<string, LabelArtifacts>(); // key = labelId

  set(labelId: string, artifacts: LabelArtifacts): void {
    this.store.set(labelId, artifacts);
  }

  get(labelId: string): LabelArtifacts | undefined {
    return this.store.get(labelId);
  }

  delete(labelId: string): boolean {
    return this.store.delete(labelId);
  }

  has(labelId: string): boolean {
    return this.store.has(labelId);
  }

  /** Diagnostic — approximate memory footprint in bytes */
  approximateSize(): number {
    let total = 0;
    this.store.forEach((art) => {
      if (art.maskB64) total += art.maskB64.length;
      if (art.overlayB64) total += art.overlayB64.length;
      if (art.frameResults) {
        Object.values(art.frameResults).forEach((r: { maskB64: string; overlayB64?: string }) => {
          if (r.maskB64) total += r.maskB64.length;
          if (r.overlayB64) total += r.overlayB64.length;
        });
      }
    });
    return total;
  }
}

export const maskArtifactStore = new MaskArtifactStore();
