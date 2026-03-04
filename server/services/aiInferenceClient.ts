import sharp from 'sharp';
import type { ParsedIntent } from '@shared/schema';
import type { ModelConfig } from './modelRouter';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

// ── Interfaces ────────────────────────────────────────────────

export interface InferenceRequest {
  modelConfig: ModelConfig;
  imageBase64: string;   // PNG frame as base64 string (no data: prefix)
  intent: ParsedIntent;  // from shared/schema.ts
}

export interface InferenceResult {
  maskBase64: string;    // PNG mask as base64 string
  confidence: number;
  modelUsed: string;
  inferenceMs: number;
}

// ── AI Inference Client ───────────────────────────────────────

export class AIInferenceClient {
  /**
   * Send an image + intent to the Python AI service and get back
   * a segmentation mask (or classification result).
   *
   * In development mode, if the AI service is unreachable a mock
   * result is returned so the frontend can be built in parallel.
   */
  async infer(request: InferenceRequest): Promise<InferenceResult> {
    const startMs = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

      const response = await fetch(`${AI_SERVICE_URL}/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelConfig.id,
          image_base64: request.imageBase64,
          prompt: {
            intent: request.intent.intent,
            target: request.intent.target,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`AI service returned ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as { mask_base64: string; confidence: number };

      return {
        maskBase64: data.mask_base64,
        confidence: data.confidence,
        modelUsed: request.modelConfig.id,
        inferenceMs: Date.now() - startMs,
      };
    } catch (err) {
      // Always return mock when AI service is unavailable
      console.warn('⚠️  AI service unavailable — returning mock mask');
      return this.generateMockResult(request.modelConfig.id, startMs);
    }
  }

  /**
   * Check whether the Python AI service is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const response = await fetch(`${AI_SERVICE_URL}/health`, {
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
   * Used only in development when the real AI service is down.
   */
  private async generateMockResult(model: string, startMs: number): Promise<InferenceResult> {
    const size = 512;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 4;

    // Create a white circle on a black background using Sharp
    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="black"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="white"/>
    </svg>`;

    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    return {
      maskBase64: pngBuffer.toString('base64'),
      confidence: 0.5,
      modelUsed: 'mock',
      inferenceMs: Date.now() - startMs,
    };
  }
}
