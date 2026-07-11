CREATE TABLE "ai_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" varchar NOT NULL,
	"name" text NOT NULL,
	"input_source" text NOT NULL,
	"modality" text,
	"bbox" jsonb,
	"target" text NOT NULL,
	"output_dir" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frame_processing_batches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" varchar NOT NULL,
	"batch_number" integer NOT NULL,
	"start_frame" integer NOT NULL,
	"end_frame" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"worker_id" text,
	"processed_at" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text,
	"duration" real,
	"width" integer,
	"height" integer,
	"frame_rate" real,
	"total_frames" integer,
	"error_message" text,
	"video_status" text,
	"job_status" text,
	"file_path" text,
	"original_size" integer,
	"progress" real,
	"mask_data" jsonb,
	"output_settings" jsonb,
	"created_at" text,
	"completed_at" text,
	"job_type" text,
	"file_list" jsonb,
	"ai_labels" jsonb,
	"uploaded_at" text,
	"phi_status" text,
	"attestation_record" jsonb,
	"source_type" text,
	"extraction_rate" real,
	"template_mask" jsonb,
	"labeling" jsonb,
	"ai_initialized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_processing_batches" ADD CONSTRAINT "frame_processing_batches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;