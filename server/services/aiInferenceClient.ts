import sharp from 'sharp';
import type { ParsedIntent } from '@shared/schema';
import type { ModelConfig } from './modelRouter';

const SAM2_SERVICE_URL = process.env.SAM2_SERVICE_URL || 'http://172.31.6.85:8001';

// ── Interfaces ────────────────────────────────────────────────

export interface InferenceRequest {
  modelConfig: ModelConfig;
  imageBase64: string;   // PNG frame as base64 string (no data: prefix)
  intent: ParsedIntent;  // from shared/schema.ts
  jobId?: string;        // passed through to GPU service for tracking
}

export interface InferenceResult {
  maskBase64: string;       // PNG mask as base64 string
  overlayBase64?: string;   // PNG overlay as base64 string (green tint on image)
  confidence: number;
  modelUsed: string;
  inferenceMs: number;
  mock?: boolean;           // true when GPU service returned a mock or we fell back locally
}

// ── MedSAM2 GPU service response shape ───────────────────────

interface MedSAM2Response {
  job_id: string;
  target: string;
  success: boolean;
  mask_b64: string;
  overlay_b64: string;
  confidence: number;
  mock: boolean;
  error?: string;
}

// ── AI Inference Client ───────────────────────────────────────

export class AIInferenceClient {
  /**
   * Send an image + intent to the MedSAM2 GPU service and get back
   * a segmentation mask.
   *
   * Falls back to a local mock result if the GPU service is unreachable
   * so the Node.js app never crashes due to inference failures.
   */
  async infer(request: InferenceRequest): Promise<InferenceResult> {
    const startMs = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000); // 30s — MedSAM2 can be slow on first run

      const body = {
        job_id: request.jobId || 'unknown',
        image_b64: request.imageBase64,
        target: request.intent.target || 'unknown',
        bbox: null,             // will add UI bbox drawing later
        points: null,           // will add point prompts later
        use_auto_prompt: true,  // let MedSAM2 auto-generate center bbox
      };

      console.log(`🤖 Calling MedSAM2 at ${SAM2_SERVICE_URL}/segment — target: "${body.target}"`);

      const response = await fetch(`${SAM2_SERVICE_URL}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`MedSAM2 service returned ${response.status}: ${text}`);
      }

      const data = await response.json() as MedSAM2Response;

      if (!data.success) {
        throw new Error(`MedSAM2 inference failed: ${data.error || 'unknown error'}`);
      }

      if (data.mock) {
        console.warn('⚠️  MedSAM2 returned a MOCK result — checkpoint not loaded on GPU instance');
      } else {
        console.log(`✅ MedSAM2 inference complete — confidence: ${(data.confidence * 100).toFixed(1)}%`);
      }

      return {
        maskBase64: data.mask_b64,
        overlayBase64: data.overlay_b64 || undefined,
        confidence: data.confidence,
        modelUsed: data.mock ? 'medsam2-mock' : 'medsam2',
        inferenceMs: Date.now() - startMs,
        mock: data.mock,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  MedSAM2 GPU service unreachable — falling back to local mock. Reason: ${reason}`);
      return this.generateMockResult(startMs);
    }
  }

  /**
   * Check whether the MedSAM2 GPU service is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const response = await fetch(`${SAM2_SERVICE_URL}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Generate a white-circle-on-black mock mask (512×512).
   * Used only as a fallback when the MedSAM2 GPU service is unreachable.
   */
  private async generateMockResult(startMs: number): Promise<InferenceResult> {
    const size = 512;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 4;

    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="black"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="white"/>
    </svg>`;

    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    return {
      maskBase64: pngBuffer.toString('base64'),
      confidence: 0.0,
      modelUsed: 'mock',
      inferenceMs: Date.now() - startMs,
      mock: true,
    };
  }
}
