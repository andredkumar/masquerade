import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Hub-and-spoke `jobs` table (Phase 5C-1, Option A3 — single source) ──
//
// ONE canonical row per job id. Each *fact* lives in exactly one column.
// MemStorage's two independent maps (videoJobs, jobsV2) are reproduced not by
// persisting two records, but by deriving the legacy `VideoJob` and the clean
// `Job` shapes from this single row in the PgStorage shim. There is no
// `video_job` blob and no `has_job_v2`: facet presence is carried by the two
// status columns, which double as existence markers (a job's status is always
// a non-null string when that facet exists).
//
//   • Shared facts (filename, duration, width, height, frame_rate,
//     total_frames, error_message): genuinely ONE fact each — identical across
//     the two facets in the live 1:1 app — so they occupy ONE column read by
//     both derivations. When two facets coexist, both populate the same value;
//     deleting one facet leaves these intact for the survivor.
//
//   • Two status columns — the ONLY place two columns model two genuine facts.
//     `video_status` (legacy 6-value lifecycle) and `job_status` (V2 3-value
//     lifecycle) diverge on the same id (the VideoJob→Job status mirror is
//     lossy/non-invertible), so neither can be derived from the other.
//       video_status IS NOT NULL ⟺ VideoJob facet present.
//       job_status   IS NOT NULL ⟺ Job facet present.
//
//   • VideoJob-only and Job-only facts each get their own nullable column,
//     cleared when their facet is deleted while the other survives.
//
// Derived (NOT stored — see Gate A): VideoJob.outputZipPath (Unused → null),
// VideoJob.fileCount (file_list?.length ?? 1), VideoJob.jobType (= job_type),
// Job.source (shared dims + source_type).
//
// `ai_initialized` mirrors MemStorage's `job.ai` lifecycle: once addAiRun
// fires, getJobV2 must return `ai: { runs: [...] }` even after every run is
// deleted (an empty-but-present runs array), which an empty child table alone
// cannot distinguish.
export const jobs = pgTable("jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  // ── Shared facts (one fact, one column; read by BOTH derivations) ──────
  filename: text("filename"),
  duration: real("duration"),
  width: integer("width"),
  height: integer("height"),
  frameRate: real("frame_rate"),
  totalFrames: integer("total_frames"),
  errorMessage: text("error_message"),

  // ── Status columns (two genuine facts; also facet-existence markers) ──
  videoStatus: text("video_status").$type<VideoJob["status"]>(), // uploaded, extracting, ready, processing, completed, failed
  jobStatus: text("job_status").$type<Job["status"]>(),          // extracting, ready, failed

  // ── VideoJob-only facts (nullable; null ⟺ VideoJob facet absent) ──────
  filePath: text("file_path"),
  originalSize: integer("original_size"),
  progress: real("progress"),
  maskData: jsonb("mask_data"),
  outputSettings: jsonb("output_settings"),
  createdAt: text("created_at"),
  completedAt: text("completed_at"),
  jobType: text("job_type"),       // video, images
  fileList: jsonb("file_list"),    // Array of file info for image batches
  aiLabels: jsonb("ai_labels"),    // session-based AI labels

  // ── Job-only facts (nullable; null ⟺ Job facet absent) ────────────────
  uploadedAt: text("uploaded_at"),
  phiStatus: text("phi_status").$type<Job["phiStatus"]>(),
  attestationRecord: jsonb("attestation_record").$type<AttestationRecord>(),
  sourceType: text("source_type").$type<JobSource["type"]>(), // video, image_batch
  extractionRate: real("extraction_rate"),
  templateMask: jsonb("template_mask").$type<TemplateMaskState>(),
  labeling: jsonb("labeling").$type<LabelingState>(),
  aiInitialized: boolean("ai_initialized").notNull().default(false),
});

export const aiRuns = pgTable("ai_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  inputSource: text("input_source").notNull(), // extracted, template_mask, raw
  modality: text("modality"), // nullable
  bbox: jsonb("bbox"), // nullable
  target: text("target").notNull(),
  outputDir: text("output_dir").notNull(),
  labels: jsonb("labels").notNull().default([]),
  approved: boolean("approved").notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const frameProcessingBatches = pgTable("frame_processing_batches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => jobs.id),
  batchNumber: integer("batch_number").notNull(),
  startFrame: integer("start_frame").notNull(),
  endFrame: integer("end_frame").notNull(),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  workerId: text("worker_id"),
  processedAt: text("processed_at"),
});

// VideoJob is no longer Drizzle-backed (A3 dropped the `video_jobs` table —
// its facts now live as columns on `jobs`, derived by the PgStorage shim).
// The legacy `VideoJob` shape and its insert contract are therefore
// hand-authored here, reproducing the exact field types the retired
// `videoJobs.$inferSelect` / `createInsertSchema(videoJobs)` produced so no
// consumer's types shift.
export interface VideoJob {
  id: string;
  filename: string;
  filePath: string;
  originalSize: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  totalFrames: number;
  status: string; // uploaded, extracting, ready, processing, completed, failed
  progress: number;
  maskData: unknown;
  outputSettings: unknown;
  createdAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  outputZipPath: string | null;
  jobType: string; // video, images
  fileCount: number;
  fileList: unknown;
  aiLabels: unknown;
}

export const insertVideoJobSchema = z.object({
  filename: z.string(),
  filePath: z.string(),
  originalSize: z.number(),
  duration: z.number(),
  width: z.number(),
  height: z.number(),
  frameRate: z.number(),
  totalFrames: z.number(),
  status: z.string().optional(),
  progress: z.number().optional(),
  maskData: z.unknown().optional(),
  outputSettings: z.unknown().optional(),
  errorMessage: z.string().nullable().optional(),
  outputZipPath: z.string().nullable().optional(),
  jobType: z.string().optional(),
  fileCount: z.number().optional(),
  fileList: z.unknown().optional(),
  aiLabels: z.unknown().optional(),
});

export const insertFrameBatchSchema = createInsertSchema(frameProcessingBatches).omit({
  id: true,
  processedAt: true,
});

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
