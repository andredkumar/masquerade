import { readFileSync } from 'fs';
import path from 'path';
import type { ParsedIntent } from '@shared/schema';

// ── Interfaces ────────────────────────────────────────────────

export interface ModelConfig {
  id: string;
  name: string;
  type: 'segmenter' | 'classifier';
  intents: string[];
  targets: string[];
  inputShape: string;
  license: string;
  gpuRequired: boolean;
  version: string;
  available: boolean;
}

// ── Model Router ──────────────────────────────────────────────

export class ModelRouter {
  private registry: ModelConfig[];

  constructor() {
    const registryPath = path.join(process.cwd(), 'server', 'config', 'modelRegistry.json');
    this.registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  }

  /**
   * Given a parsed intent, find the best matching model config.
   *
   * Priority:
   *   1. Available models whose intents include the parsed intent
   *   2. Among those, prefer exact target match over wildcard "*"
   *   3. If no available model found, fall back to SAM2 (always try)
   */
  route(intent: ParsedIntent): ModelConfig {
    const matchingIntent = this.registry.filter(m =>
      m.intents.includes(intent.intent)
    );

    // Split into available and unavailable
    const available = matchingIntent.filter(m => m.available);
    const pool = available.length > 0 ? available : matchingIntent;

    // Prefer exact target match
    const exactMatch = pool.find(m =>
      m.targets.includes(intent.target)
    );
    if (exactMatch) return exactMatch;

    // Fall back to wildcard target
    const wildcardMatch = pool.find(m =>
      m.targets.includes('*')
    );
    if (wildcardMatch) return wildcardMatch;

    // Last resort: return SAM2 config as default
    const sam2 = this.registry.find(m => m.id === 'sam2');
    return sam2 || this.registry[0];
  }

  /**
   * Return the full model registry list.
   */
  listModels(): ModelConfig[] {
    return this.registry;
  }
}
