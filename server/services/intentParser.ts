import Anthropic from '@anthropic-ai/sdk';
import type { ParsedIntent } from '@shared/schema';

// ── Keyword dictionaries ──────────────────────────────────────

const INTENT_KEYWORDS: Record<string, string[]> = {
  segment:  ['segment', 'mask', 'outline', 'contour', 'delineate', 'draw around', 'annotate'],
  classify: ['classify', 'identify', 'what view', 'what is', 'categorize', 'which view', 'detect view'],
  detect:   ['detect', 'find', 'locate', 'count', 'highlight', 'show me', 'where is'],
  label:    ['label', 'tag', 'name', 'annotate', 'mark'],
  export:   ['export', 'download', 'create dataset', 'save', 'package'],
};

const TARGET_SYNONYMS: Record<string, string[]> = {
  'pleural effusion':     ['effusion', 'pleural effusion', 'fluid', 'pleural fluid'],
  'b-line':               ['b-line', 'b line', 'bline', 'comet tail', 'comet artifact'],
  'pleural line':         ['pleural line', 'pleura', 'pleural surface'],
  'lung sliding':         ['sliding', 'lung sliding', 'a-lines'],
  'view':                 ['view', 'window', 'probe position', 'acoustic window'],
  'pericardial effusion': ['pericardial', 'pericardial effusion', 'cardiac effusion'],
  'ivc':                  ['ivc', 'inferior vena cava', 'vena cava'],
};

// Map intent → default output type
const DEFAULT_OUTPUT: Record<string, string> = {
  segment:  'mask',
  classify: 'label',
  detect:   'bounding_box',
  label:    'label',
  export:   'dataset',
  clarify:  '',
};

// Temporal keywords that imply tracking over frames
const TEMPORAL_KEYWORDS = ['over time', 'track', 'across frames', 'throughout', 'temporal', 'motion', 'movement'];

// ── Intent Parser ─────────────────────────────────────────────

export class IntentParser {
  /**
   * Parse a natural-language ultrasound command into structured intent JSON.
   * Stage 1 uses deterministic keyword matching; Stage 2 falls back to Claude API.
   */
  async parse(command: string): Promise<ParsedIntent> {
    const lower = command.toLowerCase().trim();

    // ── Stage 1: keyword rules ──────────────────────────────
    const intentMatch = this.matchIntent(lower);
    const targetMatch = this.matchTarget(lower);
    const temporal = TEMPORAL_KEYWORDS.some(kw => lower.includes(kw));

    if (intentMatch) {
      const confidence = targetMatch.canonical ? 0.95 : 0.7;

      if (confidence >= 0.8) {
        return {
          intent: intentMatch as ParsedIntent['intent'],
          target: targetMatch.canonical || targetMatch.raw,
          output: DEFAULT_OUTPUT[intentMatch],
          temporal,
          confidence,
        };
      }

      // Intent clear but target unknown — still above threshold with raw noun
      if (confidence >= 0.7 && targetMatch.raw) {
        return {
          intent: intentMatch as ParsedIntent['intent'],
          target: targetMatch.raw,
          output: DEFAULT_OUTPUT[intentMatch],
          temporal,
          confidence: 0.7,
        };
      }
    }

    // ── Stage 2: Claude API fallback ────────────────────────
    return this.parseWithClaude(command);
  }

  // ── Private helpers ───────────────────────────────────────

  private matchIntent(lower: string): string | null {
    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          return intent;
        }
      }
    }
    return null;
  }

  private matchTarget(lower: string): { canonical: string | null; raw: string } {
    // Try canonical synonyms first
    for (const [canonical, synonyms] of Object.entries(TARGET_SYNONYMS)) {
      for (const syn of synonyms) {
        if (lower.includes(syn)) {
          return { canonical, raw: syn };
        }
      }
    }

    // Extract the noun phrase after the intent keyword as a raw target
    const raw = this.extractNounPhrase(lower);
    return { canonical: null, raw };
  }

  private extractNounPhrase(lower: string): string {
    // Remove common intent verbs and prepositions to isolate the noun phrase
    const stripped = lower
      .replace(/^(segment|mask|outline|contour|delineate|draw around|annotate|classify|identify|detect|find|locate|count|highlight|show me|where is|label|tag|name|mark|export|download|create dataset|save|package)\s*/i, '')
      .replace(/^(the|a|an|all|every|each|this|that|those|these)\s+/i, '')
      .trim();
    return stripped || lower;
  }

  private async parseWithClaude(command: string): Promise<ParsedIntent> {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.warn('ANTHROPIC_API_KEY not set — cannot use Claude fallback');
        return this.clarifyFallback();
      }

      const client = new Anthropic({ apiKey });

      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system:
          'You parse ultrasound imaging commands into JSON. Only return valid JSON, no explanation.',
        messages: [
          {
            role: 'user',
            content: `Parse this ultrasound command into JSON with these exact fields:
{
  "intent": "segment" | "classify" | "detect" | "label" | "export" | "clarify",
  "target": "<anatomical structure or empty string>",
  "output": "mask" | "label" | "bounding_box" | "dataset" | "",
  "temporal": true | false,
  "confidence": <0-1>,
  "clarifyPrompt": "<question to ask user, only if intent is clarify>"
}

Command: "${command}"`,
          },
        ],
      });

      // Extract text from the response
      const textBlock = message.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        return this.clarifyFallback();
      }

      const parsed = JSON.parse(textBlock.text) as ParsedIntent;

      // Validate required fields
      if (!parsed.intent || parsed.confidence === undefined) {
        return this.clarifyFallback();
      }

      return parsed;
    } catch (err) {
      console.error('Claude intent parsing failed:', err);
      return this.clarifyFallback();
    }
  }

  private clarifyFallback(): ParsedIntent {
    return {
      intent: 'clarify',
      target: '',
      output: '',
      temporal: false,
      confidence: 0,
      clarifyPrompt:
        'I did not understand that command. Try: "segment effusion" or "classify view".',
    };
  }
}
