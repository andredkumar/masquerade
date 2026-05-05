#!/usr/bin/env tsx
/**
 * Manual disk-cleanup CLI.
 *
 * Runs the same `sweepDirectory` logic the hourly cron uses, on demand.
 * Useful for operators who want to immediately reclaim disk after a known
 * batch finished, or to inspect what *would* be deleted before committing.
 *
 * Usage:
 *   tsx scripts/cleanup-now.ts                       # sweep all three dirs, real delete
 *   tsx scripts/cleanup-now.ts --dry-run             # log only, delete nothing
 *   tsx scripts/cleanup-now.ts --dir=uploads         # scope to one dir
 *   tsx scripts/cleanup-now.ts --dir=temp_processed --dry-run
 *
 * Retention windows match the cron's: 2h / 6h / 24h. Pass --max-age-ms=0
 * to override and delete everything regardless of age.
 */

import {
  sweepDirectory,
  UPLOADS_DIR,
  TEMP_EXTRACTED_DIR,
  TEMP_PROCESSED_DIR,
  UPLOADS_MAX_AGE_MS,
  TEMP_EXTRACTED_MAX_AGE_MS,
  TEMP_PROCESSED_MAX_AGE_MS,
} from '../server/services/cleanup.ts';

type DirKey = 'uploads' | 'temp_extracted' | 'temp_processed';

interface ParsedArgs {
  dryRun: boolean;
  dir: DirKey | null;
  maxAgeOverride: number | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { dryRun: false, dir: null, maxAgeOverride: null };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--dir=')) {
      const v = arg.slice('--dir='.length) as DirKey;
      if (v !== 'uploads' && v !== 'temp_extracted' && v !== 'temp_processed') {
        console.error(`Invalid --dir=${v}. Must be one of: uploads, temp_extracted, temp_processed.`);
        process.exit(2);
      }
      out.dir = v;
    } else if (arg.startsWith('--max-age-ms=')) {
      const n = parseInt(arg.slice('--max-age-ms='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --max-age-ms=${arg}. Must be a non-negative integer.`);
        process.exit(2);
      }
      out.maxAgeOverride = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx scripts/cleanup-now.ts [--dry-run] [--dir=uploads|temp_extracted|temp_processed] [--max-age-ms=<n>]'
      );
      process.exit(0);
    } else {
      console.warn(`Unknown argument: ${arg} (ignored)`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Build the (dir, maxAge) plan based on flags.
  const plan: Array<[string, number]> = [];
  const pushPlan = (key: DirKey) => {
    const dir =
      key === 'uploads' ? UPLOADS_DIR :
      key === 'temp_extracted' ? TEMP_EXTRACTED_DIR :
      TEMP_PROCESSED_DIR;
    const defaultMax =
      key === 'uploads' ? UPLOADS_MAX_AGE_MS :
      key === 'temp_extracted' ? TEMP_EXTRACTED_MAX_AGE_MS :
      TEMP_PROCESSED_MAX_AGE_MS;
    const maxAge = args.maxAgeOverride !== null ? args.maxAgeOverride : defaultMax;
    plan.push([dir, maxAge]);
  };

  if (args.dir) {
    pushPlan(args.dir);
  } else {
    pushPlan('uploads');
    pushPlan('temp_extracted');
    pushPlan('temp_processed');
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
