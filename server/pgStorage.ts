import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from './db';
import {
  jobs,
  aiRuns,
  frameProcessingBatches,
  type VideoJob,
  type InsertVideoJob,
  type FrameProcessingBatch,
  type InsertFrameBatch,
  type ProcessingProgress,
  type Job,
  type JobSource,
  type TemplateMaskState,
  type AIRun,
  type Modality,
  type AiLabel,
  type AttestationRecord,
} from '@shared/schema';
import { type IStorage, mapVideoJobStatusToJobStatus } from './storage';

/**
 * Postgres-backed IStorage (Phase 5C-1, Option A3 — single source of truth).
 *
 * Every job id maps to ONE `jobs` row in which each *fact* lives in exactly
 * one column. MemStorage's two independent maps (videoJobs, jobsV2) are NOT
 * persisted as two records; instead this shim DERIVES the legacy `VideoJob`
 * and the clean `Job` shapes from that single row:
 *
 *   • Facet presence is carried by the two status columns (no blob, no
 *     has_job_v2). `video_status IS NOT NULL` ⟺ VideoJob facet exists;
 *     `job_status IS NOT NULL` ⟺ Job facet exists. A facet's status is always
 *     a non-null string while that facet lives, so the column doubles as a
 *     reliable existence marker.
 *
 *   • Shared facts (filename, duration, width, height, frameRate, totalFrames,
 *     errorMessage) occupy ONE column each, read by both derivations. They are
 *     genuinely one fact in the live 1:1 app, where the two facets never hold
 *     divergent values for them — the only fact that genuinely diverges
 *     (status) is the one place two columns exist. Writing one facet leaves the
 *     other facet's exclusive columns untouched, so deleting a facet preserves
 *     the survivor.
 *
 *   • Derived, never stored (Gate A): VideoJob.outputZipPath (Unused → null),
 *     VideoJob.fileCount (= fileList.length, else 1), VideoJob.jobType
 *     (= job_type column), Job.source (shared dims + source_type).
 *
 * `ai_initialized` mirrors MemStorage's `job.ai` lifecycle so getJobV2 returns
 * a present-but-empty `ai: { runs: [] }` after every run is deleted.
 *
 * MemStorage remains the live runtime; this class is exercised only by the
 * conformance harness until the Postgres cutover (5C-2+).
 */
export class PgStorage implements IStorage {
  // Progress is ephemeral — no need to persist it in the database.
  private processingProgress: Map<string, ProcessingProgress>;

  constructor() {
    this.processingProgress = new Map();
  }

  // ── Video Jobs (VideoJob facet — derived from `jobs` columns) ────────

  async createVideoJob(insertJob: InsertVideoJob): Promise<VideoJob> {
    const id = randomUUID();
    const job: VideoJob = {
      ...insertJob,
      id,
      status: insertJob.status || 'uploaded',
      progress: insertJob.progress || 0,
      maskData: insertJob.maskData ?? null,
      outputSettings: insertJob.outputSettings ?? null,
      outputZipPath: insertJob.outputZipPath ?? null,
      fileList: insertJob.fileList ?? null,
      aiLabels: insertJob.aiLabels ?? null,
      jobType: insertJob.jobType || 'video',
      fileCount: insertJob.fileCount || 1,
      createdAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
    };
    // Upsert only the VideoJob + shared columns; any pre-existing Job facet on
    // the same id (its exclusive columns + job_status) is left intact.
    const cols = this.videoJobToColumns(job);
    await db
      .insert(jobs)
      .values({ id, ...cols })
      .onConflictDoUpdate({ target: jobs.id, set: cols });
    return job;
  }

  async getVideoJob(id: string): Promise<VideoJob | undefined> {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (!row || row.videoStatus == null) return undefined;
    return this.rowToVideoJob(row);
  }

  async updateVideoJob(
    id: string,
    updates: Partial<VideoJob>,
  ): Promise<VideoJob | undefined> {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (!row || row.videoStatus == null) return undefined;

    const updatedJob: VideoJob = { ...this.rowToVideoJob(row), ...updates };
    const set: Partial<typeof jobs.$inferInsert> =
      this.videoJobToColumns(updatedJob);

    // Mirror VideoJob.status → Job.status, but only when the Job facet exists
    // (matches MemStorage, which mirrors only if the jobsV2 entry is present).
    if (updates.status) {
      const v2Status = mapVideoJobStatusToJobStatus(updates.status);
      if (v2Status && row.jobStatus != null) {
        set.jobStatus = v2Status;
      }
    }

    await db.update(jobs).set(set).where(eq(jobs.id, id));
    return updatedJob;
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

  async deleteProcessingProgress(jobId: string): Promise<void> {
    this.processingProgress.delete(jobId);
  }

  // ── Hub-and-spoke (Job facet — derived from `jobs` columns + ai_runs) ─

  async createJobV2(job: Job): Promise<Job> {
    const cols = this.jobToColumns(job);
    // Upsert only the Job + shared columns; any pre-existing VideoJob facet on
    // the same id (its exclusive columns + video_status) is left intact.
    await db
      .insert(jobs)
      .values({ id: job.id, ...cols })
      .onConflictDoUpdate({ target: jobs.id, set: cols });

    // Seed ai_runs if the incoming Job already carries runs.
    if (job.ai?.runs?.length) {
      await db
        .insert(aiRuns)
        .values(job.ai.runs.map((run) => this.aiRunToRow(job.id, run)));
    }
    return job;
  }

  async getJobV2(jobId: string): Promise<Job | undefined> {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row || row.jobStatus == null) return undefined;
    const runs = await this.listAiRuns(jobId);
    return this.rowToJob(row, runs);
  }

  async setPhiStatus(
    jobId: string,
    phiStatus: 'raw' | 'user_attested',
    attestationRecord?: AttestationRecord,
  ): Promise<Job | undefined> {
    const [row] = await db
      .select({ jobStatus: jobs.jobStatus })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!row || row.jobStatus == null) return undefined;

    const set: Partial<typeof jobs.$inferInsert> = { phiStatus };
    if (attestationRecord) set.attestationRecord = attestationRecord;
    await db.update(jobs).set(set).where(eq(jobs.id, jobId));
    return this.getJobV2(jobId);
  }

  async setTemplateMaskState(
    jobId: string,
    state: TemplateMaskState,
  ): Promise<Job | undefined> {
    const [row] = await db
      .select({ jobStatus: jobs.jobStatus })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!row || row.jobStatus == null) return undefined;

    await db.update(jobs).set({ templateMask: state }).where(eq(jobs.id, jobId));
    return this.getJobV2(jobId);
  }

  async getTemplateMaskState(
    jobId: string,
  ): Promise<TemplateMaskState | undefined> {
    const [row] = await db
      .select({ jobStatus: jobs.jobStatus, templateMask: jobs.templateMask })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!row || row.jobStatus == null) return undefined;
    return row.templateMask ?? undefined;
  }

  async addAiRun(jobId: string, run: AIRun): Promise<Job | undefined> {
    const [row] = await db
      .select({ jobStatus: jobs.jobStatus })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!row || row.jobStatus == null) return undefined;

    await db.insert(aiRuns).values(this.aiRunToRow(jobId, run));
    // Mark the ai lifecycle started so getJobV2 returns a present-but-possibly
    // empty `ai.runs` array even after later deletions.
    await db.update(jobs).set({ aiInitialized: true }).where(eq(jobs.id, jobId));
    return this.getJobV2(jobId);
  }

  async updateAiRun(
    jobId: string,
    runId: string,
    updates: Partial<AIRun>,
  ): Promise<AIRun | undefined> {
    const [existing] = await db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.jobId, jobId)));
    if (!existing) return undefined;

    const set = this.aiRunPartialToRow(updates);
    if (Object.keys(set).length > 0) {
      await db
        .update(aiRuns)
        .set(set)
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.jobId, jobId)));
    }
    const [updated] = await db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.jobId, jobId)));
    return updated ? this.rowToAiRun(updated) : undefined;
  }

  async getAiRun(jobId: string, runId: string): Promise<AIRun | undefined> {
    const [row] = await db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.jobId, jobId)));
    return row ? this.rowToAiRun(row) : undefined;
  }

  async listAiRuns(jobId: string): Promise<AIRun[]> {
    // Order by createdAt to reproduce MemStorage's insertion-order array.
    // Assumes createdAt is distinct and monotonically increasing per job
    // (ISO-8601 timestamps minted at insert time).
    const rows = await db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.jobId, jobId))
      .orderBy(aiRuns.createdAt);
    return rows.map((r) => this.rowToAiRun(r));
  }

  async deleteAiRun(jobId: string, runId: string): Promise<boolean> {
    const res = await db
      .delete(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.jobId, jobId)));
    return (res.rowCount ?? 0) > 0;
  }

  // ── Deletion (facet-independent; the surviving facet keeps the row) ──

  async deleteVideoJob(id: string): Promise<boolean> {
    // Mirror MemStorage: free the ephemeral progress entry on every delete.
    await this.deleteProcessingProgress(id);

    const [row] = await db
      .select({ videoStatus: jobs.videoStatus, jobStatus: jobs.jobStatus })
      .from(jobs)
      .where(eq(jobs.id, id));
    if (!row || row.videoStatus == null) return false;

    if (row.jobStatus != null) {
      // Job facet survives: clear only the VideoJob-exclusive columns + marker.
      // Shared columns stay — the Job facet still reads them.
      await db
        .update(jobs)
        .set({
          videoStatus: null,
          filePath: null,
          originalSize: null,
          progress: null,
          maskData: null,
          outputSettings: null,
          createdAt: null,
          completedAt: null,
          jobType: null,
          fileList: null,
          aiLabels: null,
        })
        .where(eq(jobs.id, id));
    } else {
      // No surviving facet: drop the row entirely.
      await db.delete(jobs).where(eq(jobs.id, id));
    }
    return true;
  }

  async deleteJobV2(jobId: string): Promise<boolean> {
    const [row] = await db
      .select({ videoStatus: jobs.videoStatus, jobStatus: jobs.jobStatus })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!row || row.jobStatus == null) return false;

    // Remove this job's ai_runs. On the row-drop path the FK cascade would also
    // clear them; on the column-clear path we must remove them explicitly.
    await db.delete(aiRuns).where(eq(aiRuns.jobId, jobId));

    if (row.videoStatus != null) {
      // VideoJob facet survives: clear the Job-exclusive columns + markers.
      // Shared columns stay — the VideoJob facet still reads them.
      await db
        .update(jobs)
        .set({
          jobStatus: null,
          uploadedAt: null,
          phiStatus: null,
          attestationRecord: null,
          sourceType: null,
          extractionRate: null,
          templateMask: null,
          labeling: null,
          aiInitialized: false,
        })
        .where(eq(jobs.id, jobId));
    } else {
      // No surviving facet: drop the row entirely.
      await db.delete(jobs).where(eq(jobs.id, jobId));
    }
    return true;
  }

  // ── Mapping helpers ─────────────────────────────────────────

  /**
   * VideoJob → `jobs` shared + VideoJob-exclusive columns (sets video_status
   * marker). Job-exclusive columns and job_status are NOT touched.
   * outputZipPath and fileCount are intentionally not persisted — both are
   * derived on read (Gate A: Unused / = fileList.length).
   */
  private videoJobToColumns(job: VideoJob): Partial<typeof jobs.$inferInsert> {
    return {
      // shared
      filename: job.filename,
      duration: job.duration,
      width: job.width,
      height: job.height,
      frameRate: job.frameRate,
      totalFrames: job.totalFrames,
      errorMessage: job.errorMessage,
      // marker
      videoStatus: job.status,
      // VideoJob-exclusive
      filePath: job.filePath,
      originalSize: job.originalSize,
      progress: job.progress,
      maskData: job.maskData ?? null,
      outputSettings: job.outputSettings ?? null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      jobType: job.jobType,
      fileList: job.fileList ?? null,
      aiLabels: job.aiLabels ?? null,
    };
  }

  /**
   * Job → `jobs` shared + Job-exclusive columns (sets job_status marker).
   * VideoJob-exclusive columns and video_status are NOT touched.
   */
  private jobToColumns(job: Job): Partial<typeof jobs.$inferInsert> {
    return {
      // shared
      filename: job.filename,
      duration: job.source.duration,
      width: job.source.width,
      height: job.source.height,
      frameRate: job.source.frameRate,
      totalFrames: job.source.totalFrames,
      errorMessage: job.errorMessage,
      // marker
      jobStatus: job.status,
      // Job-exclusive
      uploadedAt: job.uploadedAt,
      phiStatus: job.phiStatus,
      attestationRecord: job.attestationRecord ?? null,
      sourceType: job.source.type,
      extractionRate: job.extractionRate,
      templateMask: job.templateMask ?? null,
      labeling: job.labeling ?? null,
      aiInitialized: !!job.ai,
    };
  }

  /** `jobs` row → VideoJob. Caller guarantees video_status is non-null. */
  private rowToVideoJob(row: typeof jobs.$inferSelect): VideoJob {
    return {
      id: row.id,
      filename: row.filename!,
      filePath: row.filePath!,
      originalSize: row.originalSize!,
      duration: row.duration!,
      width: row.width!,
      height: row.height!,
      frameRate: row.frameRate!,
      totalFrames: row.totalFrames!,
      status: row.videoStatus!,
      progress: row.progress!,
      maskData: row.maskData ?? null,
      outputSettings: row.outputSettings ?? null,
      createdAt: row.createdAt ?? null,
      completedAt: row.completedAt ?? null,
      errorMessage: row.errorMessage ?? null,
      // Derived (Gate A):
      outputZipPath: null, // Unused — no live producer or consumer.
      jobType: row.jobType!,
      fileCount: Array.isArray(row.fileList) ? row.fileList.length : 1,
      fileList: row.fileList ?? null,
      aiLabels: row.aiLabels ?? null,
    };
  }

  /** `jobs` row + ai_runs → Job. Caller guarantees job_status is non-null. */
  private rowToJob(row: typeof jobs.$inferSelect, runs: AIRun[]): Job {
    const job: Job = {
      id: row.id,
      filename: row.filename!,
      uploadedAt: row.uploadedAt!,
      phiStatus: row.phiStatus as Job['phiStatus'],
      source: {
        duration: row.duration!,
        width: row.width!,
        height: row.height!,
        frameRate: row.frameRate!,
        totalFrames: row.totalFrames!,
        type: row.sourceType as JobSource['type'],
      },
      extractionRate: row.extractionRate!,
      status: row.jobStatus as Job['status'],
      errorMessage: row.errorMessage,
    };
    if (row.attestationRecord) job.attestationRecord = row.attestationRecord;
    if (row.templateMask) job.templateMask = row.templateMask;
    if (row.labeling != null) job.labeling = row.labeling;
    // Present-but-empty runs array once the ai lifecycle has started.
    if (row.aiInitialized) job.ai = { runs };
    return job;
  }

  /** AIRun → ai_runs insert row (preserves run.id). */
  private aiRunToRow(jobId: string, run: AIRun): typeof aiRuns.$inferInsert {
    return {
      id: run.id,
      jobId,
      name: run.name,
      inputSource: run.inputSource,
      modality: run.modality ?? null,
      bbox: run.bbox ?? null,
      target: run.target,
      outputDir: run.outputDir,
      labels: run.labels,
      approved: run.approved,
      createdAt: run.createdAt,
    };
  }

  /** Partial<AIRun> → ai_runs update set (only provided keys; id excluded). */
  private aiRunPartialToRow(
    updates: Partial<AIRun>,
  ): Partial<typeof aiRuns.$inferInsert> {
    const set: Partial<typeof aiRuns.$inferInsert> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.inputSource !== undefined) set.inputSource = updates.inputSource;
    if (updates.modality !== undefined) set.modality = updates.modality;
    if (updates.bbox !== undefined) set.bbox = updates.bbox;
    if (updates.target !== undefined) set.target = updates.target;
    if (updates.outputDir !== undefined) set.outputDir = updates.outputDir;
    if (updates.labels !== undefined) set.labels = updates.labels;
    if (updates.approved !== undefined) set.approved = updates.approved;
    if (updates.createdAt !== undefined) set.createdAt = updates.createdAt;
    return set;
  }

  /** ai_runs row → AIRun. */
  private rowToAiRun(row: typeof aiRuns.$inferSelect): AIRun {
    return {
      id: row.id,
      name: row.name,
      inputSource: row.inputSource as AIRun['inputSource'],
      modality: (row.modality as Modality | null) ?? null,
      bbox: (row.bbox as AIRun['bbox']) ?? null,
      target: row.target,
      outputDir: row.outputDir,
      labels: (row.labels as AiLabel[]) ?? [],
      approved: row.approved,
      createdAt: row.createdAt,
    };
  }
}
