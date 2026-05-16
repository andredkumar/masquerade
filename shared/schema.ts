import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const videoJobs = pgTable("video_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  filePath: text("file_path").notNull(),
  originalSize: integer("original_size").notNull(),
  duration: real("duration").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  frameRate: real("frame_rate").notNull(),
  totalFrames: integer("total_frames").notNull(),
  status: text("status").notNull().default("uploaded"), // uploaded, extracting, ready, processing, completed, failed
  progress: real("progress").notNull().default(0),
  maskData: jsonb("mask_data"),
  outputSettings: jsonb("output_settings"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  errorMessage: text("error_message"),
  outputZipPath: text("output_zip_path"),
  // New fields for multiple file support
  jobType: text("job_type").notNull().default("video"), // video, images
  fileCount: integer("file_count").notNull().default(1),
  fileList: jsonb("file_list"), // Array of file info for image batches
  // Session-based AI labels
  aiLabels: jsonb("ai_labels").default([]),
});

export const frameProcessingBatches = pgTable("frame_processing_batches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => videoJobs.id),
  batchNumber: integer("batch_number").notNull(),
  startFrame: integer("start_frame").notNull(),
  endFrame: integer("end_frame").notNull(),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  workerId: text("worker_id"),
  processedAt: text("processed_at"),
});

export const insertVideoJobSchema = createInsertSchema(videoJobs).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export const insertFrameBatchSchema = createInsertSchema(frameProcessingBatches).omit({
  id: true,
  processedAt: true,
});

export type VideoJob = typeof videoJobs.$inferSelect;
export type InsertVideoJob = z.infer<typeof insertVideoJobSchema>;
export type FrameProcessingBatch = typeof frameProcessingBatches.$inferSelect;
export type InsertFrameBatch = z.infer<typeof insertFrameBatchSchema>;

// File info for image batches
export interface FileInfo {
  filename: string;
  originalName: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
}

export interface MaskData {
  type: 'rectangle' | 'circle' | 'polygon' | 'freeform';
  coordinates: number[] | { x: number; y: number; width: number; height: number }; // Support both legacy and new formats
  opacity: number;
  aspectRatioMode?: 'stretch' | 'letterbox' | 'crop';
  canvasWidth?: number;
  canvasHeight?: number;
  // New base64 canvas approach (preferred)
  canvasDataUrl?: string; // Full data URL from canvas.toDataURL()
  // Comprehensive dimension tracking for coordinate alignment
  originalCanvasDimensions?: {
    width: number;
    height: number;
  };
  displayDimensions?: {
    width: number;
    height: number;
  };
  devicePixelRatio?: number;
  aspectRatio?: number;
  imageAspectRatio?: number;
  imageDimensions?: {
    width: number;
    height: number;
  };
  // Display transformation info for coordinate mapping
  imageDisplayInfo?: {
    scale: number;
    offsetX: number;
    offsetY: number;
  };
  // AI label metadata (populated when mask is AI-generated)
  aiLabel?: {
    intent: string;
    target: string;
    confidence: number | null;
    model: string;
  };
  // Session-based multi-label list
  aiLabels?: AiLabel[];
}

export interface OutputSettings {
  size: '224x224' | '256x256' | '512x512' | '1024x1024' | '416x416' | 'original' | 'custom';
  customWidth?: number;
  customHeight?: number;
  width?: number; // Support direct width/height
  height?: number;
  format: 'png' | 'jpg';
  includeMetadata: boolean;
  parallelThreads: number;
  batchSize: number;
  aspectRatioMode: 'stretch' | 'letterbox' | 'crop';
}

// AI label stored per-session on the job record.
//
// IMPORTANT: Heavy mask/overlay PNG artifacts are persisted on disk under
// spokes/ai/<jobId>/<runId>/ (Phase 3b), not on this interface. Only
// lightweight per-frame metadata (confidence scores) is stored here.
export type Modality = 'cardiac' | 'lung' | 'abdominal' | 'other';

export interface AiLabel {
  id: string;        // randomUUID
  intent: string;
  target: string;
  modality?: Modality | null;  // imaging modality — drives GPU checkpoint routing
  confidence: number | null;   // first-frame confidence (for display)
  model: string;
  timestamp: string;
  approved: boolean;
  bbox?: { x1: number; y1: number; x2: number; y2: number } | null; // user-drawn prompt (image pixel coords)
  // Per-frame confidence scores — populated when Step 4 runs across all frames.
  // Mask/overlay PNGs live on disk under spokes/ai/<jobId>/<runId>/, not here.
  frameResults?: Record<number, {
    confidence: number;
  }>;
}

// ── Hub-and-spoke types (Phase 2) ──────────────────────────────────────
//
// These types represent the TARGET data model for the hub-and-spoke refactor.
// During Phase 2, no code references them yet — they are plumbing for Phase 3.
// The existing VideoJob / MaskData / OutputSettings / AiLabel types above
// remain the active runtime types until Phase 3 migrates endpoints.
//
// NOTE: Drizzle table definitions above are NOT updated here. The runtime is
// MemStorage; Drizzle table changes will be reconciled in the Postgres
// migration (separate from this refactor).

/** PHI attestation record, stored on the Job when user attests PHI status. */
export interface AttestationRecord {
  attestedAt: string; // ISO 8601 timestamp
  choice: 'contains_phi' | 'no_phi';
}

/** Source media metadata, set at upload time. */
export interface JobSource {
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  totalFrames: number;
  type: 'video' | 'image_batch';
}

/**
 * Hub-and-spoke Job shape. Replaces the linear-pipeline VideoJob in Phase 3.
 *
 * `templateMask`, `labeling`, and `ai` are optional per-spoke state objects.
 * A spoke's state is absent until the user first interacts with that spoke.
 */
export interface Job {
  id: string;
  filename: string;
  uploadedAt: string;
  phiStatus: 'raw' | 'user_attested';
  attestationRecord?: AttestationRecord;
  source: JobSource;
  extractionRate: number; // locked at upload, video only; images default to 1
  status: 'extracting' | 'ready' | 'failed';
  errorMessage: string | null;

  // Per-spoke state, all optional
  templateMask?: TemplateMaskState;
  labeling?: LabelingState;
  ai?: AIState;
}

/** Path A — Template mask + export spoke state. */
export interface TemplateMaskState {
  status: 'idle' | 'applying' | 'complete' | 'failed';
  maskData: MaskData;
  outputSettings: OutputSettings;
  outputDir: string; // spokes/template_mask/<jobId>/
  completedAt: string | null;
}

/**
 * Path B — Labeling spoke state (placeholder).
 * Shape is TBD; reserved so Phase 3+ can populate it without a schema change.
 */
export type LabelingState = unknown;

/** Path C — AI segmentation spoke state. */
export interface AIState {
  runs: AIRun[];
}

/**
 * A single AI inference run within Path C.
 *
 * `labels` reuses the existing AiLabel interface (metadata only — no base64
 * blobs). Heavy mask/overlay PNGs will persist to disk under
 * `spokes/ai/<jobId>/<runId>/` in Phase 3.
 */
export interface AIRun {
  id: string; // UUID
  name: string; // user-supplied or auto-generated
  inputSource: 'extracted' | 'template_mask' | 'raw'; // which frames it ran against
  modality: Modality | null;
  bbox: { x1: number; y1: number; x2: number; y2: number } | null;
  target: string; // user's prompt label
  outputDir: string; // spokes/ai/<jobId>/<runId>/
  labels: AiLabel[]; // existing AiLabel shape — metadata only
  approved: boolean;
  createdAt: string;
}

// AI intent parsing result
export interface ParsedIntent {
  intent: 'segment' | 'classify' | 'detect' | 'label' | 'export' | 'clarify';
  target: string;          // e.g. "pleural effusion", "b-line", "view"
  output: string;          // e.g. "mask", "label", "bounding_box"
  temporal: boolean;       // true if the command implies tracking over time
  confidence: number;      // 0-1, how confident the parser is
  clarifyPrompt?: string;  // if intent === 'clarify', the question to ask the user
}

export interface ProcessingProgress {
  jobId: string;
  stage: 'uploading' | 'extracting' | 'processing' | 'exporting' | 'completed' | 'failed' | 'ready' | 'error';
  progress: number;
  currentFrame: number;
  totalFrames: number;
  fps: number;
  cpuUsage: number;
  memoryUsage: number;
  eta: number;
  extractionProgress?: number; // Background extraction progress
  status?: string; // Detailed status message
  errorMessage?: string;
}
