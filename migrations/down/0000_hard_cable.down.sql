-- Down-path (manual rollback) for migration 0000_hard_cable.sql
--
-- drizzle-kit generate is forward-only; this hand-authored file reverses the
-- 0000 A3 baseline. Apply with:
--   psql "$DATABASE_URL" -f migrations/down/0000_hard_cable.down.sql
--
-- Drops in reverse dependency order. Child tables (ai_runs,
-- frame_processing_batches) reference jobs.id, so they are dropped before the
-- parent (jobs). A3 has no standalone video_jobs table — VideoJob is derived
-- from columns on jobs.

DROP TABLE IF EXISTS "frame_processing_batches";
--> statement-breakpoint
DROP TABLE IF EXISTS "ai_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "jobs";
