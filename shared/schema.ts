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
