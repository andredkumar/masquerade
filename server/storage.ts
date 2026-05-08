import {
  type VideoJob,
  type InsertVideoJob,
  type FrameProcessingBatch,
  type InsertFrameBatch,
  type ProcessingProgress,
  type Job,
  type TemplateMaskState,
  type AIState,
  type AIRun,
  type AttestationRecord,
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

  // ── Hub-and-spoke methods (Phase 2 plumbing) ──────────────────────────
  // No callers yet — wired up in Phase 3.

  // Job V2 (hub-and-spoke shape)
  getJobV2(jobId: string): Promise<Job | undefined>;

  // PHI status
  setPhiStatus(jobId: string, phiStatus: 'raw' | 'user_attested', attestationRecord?: AttestationRecord): Promise<Job | undefined>;

  // Template mask spoke
  setTemplateMaskState(jobId: string, state: TemplateMaskState): Promise<Job | undefined>;
  getTemplateMaskState(jobId: string): Promise<TemplateMaskState | undefined>;

  // AI spoke
  addAiRun(jobId: string, run: AIRun): Promise<Job | undefined>;
  updateAiRun(jobId: string, runId: string, updates: Partial<AIRun>): Promise<AIRun | undefined>;
  getAiRun(jobId: string, runId: string): Promise<AIRun | undefined>;
  listAiRuns(jobId: string): Promise<AIRun[]>;
  deleteAiRun(jobId: string, runId: string): Promise<boolean>;
}

export class MemStorage implements IStorage {
  private videoJobs: Map<string, VideoJob>;
  private frameBatches: Map<string, FrameProcessingBatch>;
  private processingProgress: Map<string, ProcessingProgress>;
  // Hub-and-spoke state (Phase 2). Keyed by jobId.
  private jobsV2: Map<string, Job>;

  constructor() {
    this.videoJobs = new Map();
    this.frameBatches = new Map();
    this.processingProgress = new Map();
    this.jobsV2 = new Map();
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

  // ── Hub-and-spoke methods (Phase 2 plumbing) ──────────────────────────
  // No callers yet — wired up in Phase 3.

  async getJobV2(jobId: string): Promise<Job | undefined> {
    return this.jobsV2.get(jobId);
  }

  async setPhiStatus(
    jobId: string,
    phiStatus: 'raw' | 'user_attested',
    attestationRecord?: AttestationRecord,
  ): Promise<Job | undefined> {
    const job = this.jobsV2.get(jobId);
    if (!job) return undefined;
    job.phiStatus = phiStatus;
    if (attestationRecord) job.attestationRecord = attestationRecord;
    this.jobsV2.set(jobId, job);
    return job;
  }

  async setTemplateMaskState(jobId: string, state: TemplateMaskState): Promise<Job | undefined> {
    const job = this.jobsV2.get(jobId);
    if (!job) return undefined;
    job.templateMask = state;
    this.jobsV2.set(jobId, job);
    return job;
  }

  async getTemplateMaskState(jobId: string): Promise<TemplateMaskState | undefined> {
    return this.jobsV2.get(jobId)?.templateMask;
  }

  async addAiRun(jobId: string, run: AIRun): Promise<Job | undefined> {
    const job = this.jobsV2.get(jobId);
    if (!job) return undefined;
    if (!job.ai) job.ai = { runs: [] };
    job.ai.runs.push(run);
    this.jobsV2.set(jobId, job);
    return job;
  }

  async updateAiRun(jobId: string, runId: string, updates: Partial<AIRun>): Promise<AIRun | undefined> {
    const job = this.jobsV2.get(jobId);
    if (!job?.ai) return undefined;
    const idx = job.ai.runs.findIndex(r => r.id === runId);
    if (idx === -1) return undefined;
    job.ai.runs[idx] = { ...job.ai.runs[idx], ...updates };
    this.jobsV2.set(jobId, job);
    return job.ai.runs[idx];
  }

  async getAiRun(jobId: string, runId: string): Promise<AIRun | undefined> {
    const job = this.jobsV2.get(jobId);
    return job?.ai?.runs.find(r => r.id === runId);
  }

  async listAiRuns(jobId: string): Promise<AIRun[]> {
    return this.jobsV2.get(jobId)?.ai?.runs ?? [];
  }

  async deleteAiRun(jobId: string, runId: string): Promise<boolean> {
    const job = this.jobsV2.get(jobId);
    if (!job?.ai) return false;
    const before = job.ai.runs.length;
    job.ai.runs = job.ai.runs.filter(r => r.id !== runId);
    if (job.ai.runs.length === before) return false;
    this.jobsV2.set(jobId, job);
    return true;
  }
}

// Always use in-memory storage. PgStorage import is intentionally omitted so
// that `./db` (which throws if DATABASE_URL is unset) is never loaded and no
// Neon client is ever initialized. AI label mask/overlay artifacts still live
// in the separate maskArtifactStore (also in-memory).
export const storage = new MemStorage();
