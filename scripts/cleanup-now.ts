#!/usr/bin/env tsx
/**
 * Manual disk-cleanup CLI.
 *
 * Runs the same `sweepDirectory` logic the hourly cron uses, on demand.
 * Useful for operators who want to immediately reclaim disk after a known
 * batch finished, or to inspect what *would* be deleted before committing.
 *
 * Usage:
 *   tsx scripts/cleanup-now.ts                       # sweep all dirs, real delete
 *   tsx scripts/cleanup-now.ts --dry-run             # log only, delete nothing
 *   tsx scripts/cleanup-now.ts --dir=uploads         # scope to one dir
 *   tsx scripts/cleanup-now.ts --dir=temp_processed --dry-run
 *   tsx scripts/cleanup-now.ts --job=<jobId>         # delete all artifacts for one job
 *   tsx scripts/cleanup-now.ts --job=<jobId> --dry-run
 *
 * --job and --dir are mutually exclusive.
 *
 * Retention windows match the cron's: 2h / 6h / 24h (+ 24h for spokes).
 * Pass --max-age-ms=0 to override and delete everything regardless of age.
 */

import {
  sweepDirectory,
  cleanupJobArtifacts,
  SWEEP_TARGETS,
  UPLOADS_DIR,
  TEMP_EXTRACTED_DIR,
  TEMP_PROCESSED_DIR,
  SPOKE_TEMPLATE_MASK_DIR,
  SPOKE_AI_DIR,
  SPOKE_LABELING_DIR,
  UPLOADS_MAX_AGE_MS,
  TEMP_EXTRACTED_MAX_AGE_MS,
  TEMP_PROCESSED_MAX_AGE_MS,
  SPOKES_MAX_AGE_MS,
} from '../server/services/cleanup.ts';

type DirKey = 'uploads' | 'temp_extracted' | 'temp_processed' | 'template_mask' | 'ai' | 'labeling';

interface ParsedArgs {
  dryRun: boolean;
  dir: DirKey | null;
  jobId: string | null;
  maxAgeOverride: number | null;
}

const VALID_DIRS: DirKey[] = ['uploads', 'temp_extracted', 'temp_processed', 'template_mask', 'ai', 'labeling'];

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { dryRun: false, dir: null, jobId: null, maxAgeOverride: null };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--dir=')) {
      const v = arg.slice('--dir='.length) as DirKey;
      if (!VALID_DIRS.includes(v)) {
        console.error(`Invalid --dir=${v}. Must be one of: ${VALID_DIRS.join(', ')}.`);
        process.exit(2);
      }
      out.dir = v;
    } else if (arg.startsWith('--job=')) {
      const v = arg.slice('--job='.length).trim();
      if (!v) {
        console.error('--job= requires a non-empty jobId.');
        process.exit(2);
      }
      out.jobId = v;
    } else if (arg.startsWith('--max-age-ms=')) {
      const n = parseInt(arg.slice('--max-age-ms='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --max-age-ms=${arg}. Must be a non-negative integer.`);
        process.exit(2);
      }
      out.maxAgeOverride = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx scripts/cleanup-now.ts [--dry-run] [--dir=<dir>] [--job=<jobId>] [--max-age-ms=<n>]\n' +
        `  --dir=  one of: ${VALID_DIRS.join(', ')}\n` +
        '  --job=  delete all artifacts for a specific jobId (mutually exclusive with --dir)\n' +
        '  --dry-run  log what would be deleted, delete nothing\n' +
        '  --max-age-ms=  override retention window (0 = delete everything)'
      );
      process.exit(0);
    } else {
      console.warn(`Unknown argument: ${arg} (ignored)`);
    }
  }

  if (out.dir && out.jobId) {
    console.error('--dir and --job are mutually exclusive. Use one or the other.');
    process.exit(2);
  }

  return out;
}

function resolveDirKey(key: DirKey): [string, number] {
  switch (key) {
    case 'uploads':        return [UPLOADS_DIR, UPLOADS_MAX_AGE_MS];
    case 'temp_extracted': return [TEMP_EXTRACTED_DIR, TEMP_EXTRACTED_MAX_AGE_MS];
    case 'temp_processed': return [TEMP_PROCESSED_DIR, TEMP_PROCESSED_MAX_AGE_MS];
    case 'template_mask':  return [SPOKE_TEMPLATE_MASK_DIR, SPOKES_MAX_AGE_MS];
    case 'ai':             return [SPOKE_AI_DIR, SPOKES_MAX_AGE_MS];
    case 'labeling':       return [SPOKE_LABELING_DIR, SPOKES_MAX_AGE_MS];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── Per-job cleanup mode ──────────────────────────────────────────────
  if (args.jobId) {
    if (args.dryRun) {
      console.log(`🧹 cleanup-now: DRY-RUN — would clean all artifacts for job ${args.jobId}`);
      console.log('  (dry-run not supported for --job; use without --dry-run to execute)');
      process.exit(0);
    }
    console.log(`🧹 cleanup-now: cleaning all artifacts for job ${args.jobId}`);
    await cleanupJobArtifacts(args.jobId);
    console.log(`🧹 cleanup-now done — job ${args.jobId} artifacts removed`);
    return;
  }

  // ── Directory sweep mode (existing behavior + spoke dirs) ─────────────
  const plan: Array<[string, number]> = [];

  if (args.dir) {
    const [dir, defaultMax] = resolveDirKey(args.dir);
    const maxAge = args.maxAgeOverride !== null ? args.maxAgeOverride : defaultMax;
    plan.push([dir, maxAge]);
  } else {
    // Sweep all targets from the generalized list
    for (const [dir, defaultMax] of SWEEP_TARGETS) {
      const maxAge = args.maxAgeOverride !== null ? args.maxAgeOverride : defaultMax;
      plan.push([dir, maxAge]);
    }
  }

  console.log(
    `🧹 cleanup-now: ${args.dryRun ? 'DRY-RUN' : 'EXECUTING'}` +
    (args.maxAgeOverride !== null ? ` — max-age override: ${args.maxAgeOverride}ms` : '')
  );

  let totalDeleted = 0;
  let totalFreed = 0;
  let totalErrors = 0;

  for (const [dir, maxAge] of plan) {
    const result = await sweepDirectory(dir, maxAge, { dryRun: args.dryRun });
    totalDeleted += result.deleted;
    totalFreed += result.freedBytes;
    totalErrors += result.errors;
  }

  console.log(
    `🧹 cleanup-now done — total ${args.dryRun ? 'would-delete' : 'deleted'}: ${totalDeleted}, ` +
    `freed: ${(totalFreed / 1024 / 1024).toFixed(2)} MB, errors: ${totalErrors}`
  );

  if (totalErrors > 0) process.exit(1);
}

main().catch(err => {
  console.error('cleanup-now failed:', err);
  process.exit(1);
});
