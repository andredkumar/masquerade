import { 
  type VideoJob, 
  type InsertVideoJob, 
  type FrameProcessingBatch, 
  type InsertFrameBatch,
  type ProcessingProgress 
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Video Jobs
  createVideoJob(job: InsertVideoJob): Promise<VideoJob>;
  getVideoJob(id: string): Promise<VideoJob | undefined>;
  updateVideoJob(id: string, updates: Partial<VideoJob>): Promise<VideoJob | undefined>;
  
  // Frame Batches
  createFrameBatch(batch: InsertFrameBatch): Promise<FrameProcessingBatch>;
  getFrameBatches(jobId: string): Promise<FrameProcessingBatch[]>;
  updateFrameBatch(id: string, updates: Partial<FrameProcessingBatch>): Promise<FrameProcessingBatch | undefined>;
  
  // Progress tracking
  getProcessingProgress(jobId: string): Promise<ProcessingProgress | undefined>;
  updateProcessingProgress(jobId: string, progress: Partial<ProcessingProgress>): Promise<void>;
}

export class MemStorage implements IStorage {
  private videoJobs: Map<string, VideoJob>;
  private frameBatches: Map<string, FrameProcessingBatch>;
  private processingProgress: Map<string, ProcessingProgress>;

  constructor() {
    this.videoJobs = new Map();
    this.frameBatches = new Map();
    this.processingProgress = new Map();
  }

  async createVideoJob(insertJob: InsertVideoJob): Promise<VideoJob> {
    const id = randomUUID();
    const job: VideoJob = {
      ...insertJob,
      id,
      status: insertJob.status || 'uploaded',
      progress: insertJob.progress || 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
    };
    this.videoJobs.set(id, job);
    return job;
  }

  async getVideoJob(id: string): Promise<VideoJob | undefined> {
    return this.videoJobs.get(id);
  }

  async updateVideoJob(id: string, updates: Partial<VideoJob>): Promise<VideoJob | undefined> {
    const job = this.videoJobs.get(id);
    if (!job) return undefined;
    
    const updatedJob = { ...job, ...updates };
    this.videoJobs.set(id, updatedJob);
    return updatedJob;
  }

  async createFrameBatch(insertBatch: InsertFrameBatch): Promise<FrameProcessingBatch> {
    const id = randomUUID();
    const batch: FrameProcessingBatch = {
      ...insertBatch,
      id,
      status: insertBatch.status || 'pending',
      workerId: insertBatch.workerId || null,
      processedAt: null,
    };
    this.frameBatches.set(id, batch);
    return batch;
  }

  async getFrameBatches(jobId: string): Promise<FrameProcessingBatch[]> {
    return Array.from(this.frameBatches.values()).filter(batch => batch.jobId === jobId);
  }

  async updateFrameBatch(id: string, updates: Partial<FrameProcessingBatch>): Promise<FrameProcessingBatch | undefined> {
    const batch = this.frameBatches.get(id);
    if (!batch) return undefined;
    
    const updatedBatch = { ...batch, ...updates };
    this.frameBatches.set(id, updatedBatch);
    return updatedBatch;
  }

  async getProcessingProgress(jobId: string): Promise<ProcessingProgress | undefined> {
    return this.processingProgress.get(jobId);
  }

  async updateProcessingProgress(jobId: string, progress: Partial<ProcessingProgress>): Promise<void> {
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

import { PgStorage } from './pgStorage';
export const storage = process.env.DATABASE_URL ? new PgStorage() : new MemStorage();
