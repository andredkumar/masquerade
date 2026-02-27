import { eq } from 'drizzle-orm';
import { db } from './db';
import {
  videoJobs,
  frameProcessingBatches,
  type VideoJob,
  type InsertVideoJob,
  type FrameProcessingBatch,
  type InsertFrameBatch,
  type ProcessingProgress,
} from '@shared/schema';
import type { IStorage } from './storage';

export class PgStorage implements IStorage {
  // Progress is ephemeral — no need to persist it in the database
  private processingProgress: Map<string, ProcessingProgress>;

  constructor() {
    this.processingProgress = new Map();
  }

  // ── Video Jobs ──────────────────────────────────────────────

  async createVideoJob(insertJob: InsertVideoJob): Promise<VideoJob> {
    const [job] = await db
      .insert(videoJobs)
      .values({
        ...insertJob,
        status: insertJob.status || 'uploaded',
        progress: insertJob.progress || 0,
      })
      .returning();
    return job;
  }

  async getVideoJob(id: string): Promise<VideoJob | undefined> {
    const [job] = await db
      .select()
      .from(videoJobs)
      .where(eq(videoJobs.id, id));
    return job || undefined;
  }

  async updateVideoJob(
    id: string,
    updates: Partial<VideoJob>,
  ): Promise<VideoJob | undefined> {
    const [updated] = await db
      .update(videoJobs)
      .set(updates)
      .where(eq(videoJobs.id, id))
      .returning();
    return updated || undefined;
  }

  // ── Frame Batches ───────────────────────────────────────────

  async createFrameBatch(
    insertBatch: InsertFrameBatch,
  ): Promise<FrameProcessingBatch> {
    const [batch] = await db
      .insert(frameProcessingBatches)
      .values({
        ...insertBatch,
        status: insertBatch.status || 'pending',
      })
      .returning();
    return batch;
  }

  async getFrameBatches(jobId: string): Promise<FrameProcessingBatch[]> {
    return db
      .select()
      .from(frameProcessingBatches)
      .where(eq(frameProcessingBatches.jobId, jobId));
  }

  async updateFrameBatch(
    id: string,
    updates: Partial<FrameProcessingBatch>,
  ): Promise<FrameProcessingBatch | undefined> {
    const [updated] = await db
      .update(frameProcessingBatches)
      .set(updates)
      .where(eq(frameProcessingBatches.id, id))
      .returning();
    return updated || undefined;
  }

  // ── Processing Progress (ephemeral, in-memory) ─────────────

  async getProcessingProgress(
    jobId: string,
  ): Promise<ProcessingProgress | undefined> {
    return this.processingProgress.get(jobId);
  }

  async updateProcessingProgress(
    jobId: string,
    progress: Partial<ProcessingProgress>,
  ): Promise<void> {
    const existing = this.processingProgress.get(jobId) || {
      jobId,
      stage: 'uploading' as const,
      progress: 0,
      currentFrame: 0,
      totalFrames: 0,
      fps: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      eta: 0,
    };

    this.processingProgress.set(jobId, { ...existing, ...progress });
  }
}
