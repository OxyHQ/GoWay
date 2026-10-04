-- oxy:deploy-phase=pre
CREATE TABLE "capture_derivatives" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"job_id" text NOT NULL,
	"frame_index" integer NOT NULL,
	"object_key" text NOT NULL,
	"image_sha256" text NOT NULL,
	"image_byte_size" bigint NOT NULL,
	"mask_key" text,
	"mask_sha256" text,
	"mask_byte_size" bigint,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"privacy_pipeline_version" text NOT NULL,
	"retention_class" text DEFAULT 'privacy_safe_proxy' NOT NULL,
	"retention_reason" text DEFAULT 'awaiting_overlap' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"protected_until" timestamp with time zone,
	"extension_count" integer DEFAULT 0 NOT NULL,
	"storage_state" text DEFAULT 'stored' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"deletion_requested_reason" text,
	"deleted_at" timestamp with time zone,
	"deletion_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_derivatives_object_key_key" UNIQUE("object_key"),
	CONSTRAINT "capture_derivatives_job_frame_key" UNIQUE("job_id","frame_index"),
	CONSTRAINT "capture_derivatives_retention_class_check" CHECK ("capture_derivatives"."retention_class" in ('privacy_safe_proxy')),
	CONSTRAINT "capture_derivatives_retention_reason_check" CHECK ("capture_derivatives"."retention_reason" in ('awaiting_privacy_processing', 'awaiting_overlap', 'reconstruction_input', 'derivation_source', 'audit_window', 'rescue_extension', 'published_artifact')),
	CONSTRAINT "capture_derivatives_storage_state_check" CHECK ("capture_derivatives"."storage_state" in ('stored', 'deleting', 'deleted')),
	CONSTRAINT "capture_derivatives_deletion_reason_check" CHECK ("capture_derivatives"."deletion_reason" in ('expired', 'contributor_request', 'moderation', 'duplicate', 'invalid_media', 'superseded_by_derivative')),
	CONSTRAINT "capture_derivatives_deletion_requested_reason_check" CHECK ("capture_derivatives"."deletion_requested_reason" in ('expired', 'contributor_request', 'moderation', 'duplicate', 'invalid_media', 'superseded_by_derivative')),
	CONSTRAINT "capture_derivatives_digest_check" CHECK ("capture_derivatives"."image_sha256" ~ '^[0-9a-f]{64}$' and ("capture_derivatives"."mask_sha256" is null or "capture_derivatives"."mask_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "capture_derivatives_mask_check" CHECK (("capture_derivatives"."mask_key" is null) = ("capture_derivatives"."mask_sha256" is null)),
	CONSTRAINT "capture_derivatives_size_check" CHECK ("capture_derivatives"."image_byte_size" > 0 and ("capture_derivatives"."mask_byte_size" is null or "capture_derivatives"."mask_byte_size" > 0)
          and "capture_derivatives"."width" > 0 and "capture_derivatives"."height" > 0 and "capture_derivatives"."frame_index" >= 0),
	CONSTRAINT "capture_derivatives_key_check" CHECK ("capture_derivatives"."object_key" like 'derived/%' and ("capture_derivatives"."mask_key" is null or "capture_derivatives"."mask_key" like 'derived/%')),
	CONSTRAINT "capture_derivatives_expiry_after_creation_check" CHECK ("capture_derivatives"."expires_at" > "capture_derivatives"."created_at"),
	CONSTRAINT "capture_derivatives_expiry_ceiling_check" CHECK ("capture_derivatives"."expires_at" <= "capture_derivatives"."created_at" + interval '400 days'),
	CONSTRAINT "capture_derivatives_protected_until_check" CHECK ("capture_derivatives"."protected_until" is null or "capture_derivatives"."protected_until" <= "capture_derivatives"."expires_at"),
	CONSTRAINT "capture_derivatives_extension_count_check" CHECK ("capture_derivatives"."extension_count" between 0 and 3),
	CONSTRAINT "capture_derivatives_deletion_request_check" CHECK (("capture_derivatives"."deletion_requested_at" is null) = ("capture_derivatives"."deletion_requested_reason" is null)),
	CONSTRAINT "capture_derivatives_tombstone_check" CHECK (("capture_derivatives"."deleted_at" is null) = ("capture_derivatives"."deletion_reason" is null)),
	CONSTRAINT "capture_derivatives_deleted_state_check" CHECK (("capture_derivatives"."storage_state" = 'deleted') = ("capture_derivatives"."deleted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "street3d_capture_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_asset_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_capture_blocks_asset_key" UNIQUE("capture_asset_id"),
	CONSTRAINT "street3d_capture_blocks_hash_check" CHECK ("street3d_capture_blocks"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "street3d_capture_blocks_reason_check" CHECK (btrim("street3d_capture_blocks"."reason") <> '' and char_length("street3d_capture_blocks"."reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "street3d_capture_edges" (
	"derivative_a" text NOT NULL,
	"derivative_b" text NOT NULL,
	"inliers" integer NOT NULL,
	"matcher_version" text NOT NULL,
	"observed_in_version_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_capture_edges_pkey" PRIMARY KEY("derivative_a","derivative_b"),
	CONSTRAINT "street3d_capture_edges_order_check" CHECK ("street3d_capture_edges"."derivative_a" < "street3d_capture_edges"."derivative_b"),
	CONSTRAINT "street3d_capture_edges_inliers_check" CHECK ("street3d_capture_edges"."inliers" > 0)
);
--> statement-breakpoint
CREATE TABLE "street3d_coverage_areas" (
	"cell" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"state" text NOT NULL,
	"center_latitude" double precision NOT NULL,
	"center_longitude" double precision NOT NULL,
	"bounds_west" double precision NOT NULL,
	"bounds_south" double precision NOT NULL,
	"bounds_east" double precision NOT NULL,
	"bounds_north" double precision NOT NULL,
	"contribution_count" integer NOT NULL,
	"at_risk_until" timestamp with time zone,
	"scene_id" text,
	"latest_contribution_at" timestamp with time zone,
	"last_rescue_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_coverage_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "street3d_coverage_state_check" CHECK ("street3d_coverage_areas"."state" in ('seeded', 'partial', 'at_risk', 'reconstructable', 'reconstructing', 'needs_more_capture')),
	CONSTRAINT "street3d_coverage_count_check" CHECK ("street3d_coverage_areas"."contribution_count" > 0),
	CONSTRAINT "street3d_coverage_cell_check" CHECK ("street3d_coverage_areas"."cell" ~ '^[0-9b-hjkmnp-z]{4,9}$'),
	CONSTRAINT "street3d_coverage_at_risk_check" CHECK ("street3d_coverage_areas"."state" <> 'at_risk' or "street3d_coverage_areas"."at_risk_until" is not null)
);
--> statement-breakpoint
CREATE TABLE "street3d_job_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "street3d_job_events_type_check" CHECK ("street3d_job_events"."type" in ('heartbeat', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "street3d_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"asset_id" text,
	"scene_id" text,
	"scene_version" integer,
	"profile" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer NOT NULL,
	"worker_id" text,
	"stage" text,
	"progress" double precision,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_code" text,
	"failure_retryable" boolean,
	"failure_detail" text,
	"input_manifest_key" text,
	"input_manifest_sha256" text,
	"output_prefix" text NOT NULL,
	"input_derivative_ids" text[],
	"input_fingerprint" text,
	"result_key" text,
	"result_sha256" text,
	"metrics" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_marker_written_at" timestamp with time zone,
	"superseded_by_job_id" text,
	"artifacts_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_jobs_kind_check" CHECK ("street3d_jobs"."kind" in ('capture_privacy', 'scene_reconstruct')),
	CONSTRAINT "street3d_jobs_state_check" CHECK ("street3d_jobs"."state" in ('queued', 'leased', 'preparing', 'privacy', 'matching', 'solving', 'georeferencing', 'training', 'optimizing', 'uploading', 'validating', 'completed', 'retry_wait', 'failed', 'cancelled')),
	CONSTRAINT "street3d_jobs_profile_check" CHECK ("street3d_jobs"."profile" in ('draft', 'standard')),
	CONSTRAINT "street3d_jobs_subject_check" CHECK (("street3d_jobs"."kind" = 'capture_privacy' and "street3d_jobs"."asset_id" is not null and "street3d_jobs"."scene_id" is null)
          or ("street3d_jobs"."kind" = 'scene_reconstruct' and "street3d_jobs"."asset_id" is null and "street3d_jobs"."scene_id" is not null
              and "street3d_jobs"."scene_version" is not null and "street3d_jobs"."profile" is not null
              and "street3d_jobs"."input_manifest_key" is not null and "street3d_jobs"."input_manifest_sha256" is not null)),
	CONSTRAINT "street3d_jobs_attempt_check" CHECK ("street3d_jobs"."attempt" between 1 and "street3d_jobs"."max_attempts" and "street3d_jobs"."max_attempts" <= 20),
	CONSTRAINT "street3d_jobs_progress_check" CHECK ("street3d_jobs"."progress" is null or "street3d_jobs"."progress" between 0 and 1),
	CONSTRAINT "street3d_jobs_version_check" CHECK ("street3d_jobs"."scene_version" is null or "street3d_jobs"."scene_version" > 0),
	CONSTRAINT "street3d_jobs_finished_check" CHECK (("street3d_jobs"."state" in ('completed', 'failed', 'cancelled')) = ("street3d_jobs"."finished_at" is not null)),
	CONSTRAINT "street3d_jobs_retry_check" CHECK ("street3d_jobs"."state" <> 'retry_wait' or "street3d_jobs"."retry_after" is not null),
	CONSTRAINT "street3d_jobs_cancel_check" CHECK (("street3d_jobs"."cancel_requested_at" is null) = ("street3d_jobs"."cancel_reason" is null)),
	CONSTRAINT "street3d_jobs_digest_check" CHECK (("street3d_jobs"."input_manifest_sha256" is null or "street3d_jobs"."input_manifest_sha256" ~ '^[0-9a-f]{64}$')
          and ("street3d_jobs"."result_sha256" is null or "street3d_jobs"."result_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "street3d_jobs_failure_code_check" CHECK ("street3d_jobs"."failure_code" is null or "street3d_jobs"."failure_code" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "street3d_jobs_failure_detail_check" CHECK ("street3d_jobs"."failure_detail" is null or char_length("street3d_jobs"."failure_detail") <= 200),
	CONSTRAINT "street3d_jobs_worker_id_check" CHECK ("street3d_jobs"."worker_id" is null or char_length("street3d_jobs"."worker_id") <= 64)
);
--> statement-breakpoint
CREATE TABLE "street3d_scene_inputs" (
	"version_id" text NOT NULL,
	"capture_asset_id" text NOT NULL,
	"derivative_id" text NOT NULL,
	"registered" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_scene_inputs_pkey" PRIMARY KEY("version_id","derivative_id")
);
--> statement-breakpoint
CREATE TABLE "street3d_scene_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"scene_id" text NOT NULL,
	"version_id" text NOT NULL,
	"reporter_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "street3d_reports_reason_check" CHECK ("street3d_scene_reports"."reason" in ('privacy', 'inappropriate', 'inaccurate', 'other')),
	CONSTRAINT "street3d_reports_note_check" CHECK ("street3d_scene_reports"."note" is null or char_length("street3d_scene_reports"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "street3d_scene_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"scene_id" text NOT NULL,
	"version" integer NOT NULL,
	"job_id" text NOT NULL,
	"state" text DEFAULT 'validating' NOT NULL,
	"profile" text NOT NULL,
	"bounds_west" double precision NOT NULL,
	"bounds_south" double precision NOT NULL,
	"bounds_east" double precision NOT NULL,
	"bounds_north" double precision NOT NULL,
	"footprint" jsonb NOT NULL,
	"world_transform" jsonb NOT NULL,
	"initial_view" jsonb NOT NULL,
	"navigation" jsonb,
	"assets" jsonb NOT NULL,
	"quality" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"gate_failures" text[] DEFAULT '{}'::text[] NOT NULL,
	"observed_from" timestamp with time zone NOT NULL,
	"observed_to" timestamp with time zone NOT NULL,
	"privacy_pipeline_versions" text[] NOT NULL,
	"attributions" text[] DEFAULT '{}'::text[] NOT NULL,
	"result_sha256" text NOT NULL,
	"published_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"assets_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_versions_scene_version_key" UNIQUE("scene_id","version"),
	CONSTRAINT "street3d_versions_job_key" UNIQUE("job_id"),
	CONSTRAINT "street3d_versions_state_check" CHECK ("street3d_scene_versions"."state" in ('validating', 'failed_quality', 'published', 'superseded', 'disabled')),
	CONSTRAINT "street3d_versions_profile_check" CHECK ("street3d_scene_versions"."profile" in ('draft', 'standard')),
	CONSTRAINT "street3d_versions_version_check" CHECK ("street3d_scene_versions"."version" > 0),
	CONSTRAINT "street3d_versions_bounds_check" CHECK ("street3d_scene_versions"."bounds_south" <= "street3d_scene_versions"."bounds_north"
          and "street3d_scene_versions"."bounds_south" between -90 and 90 and "street3d_scene_versions"."bounds_north" between -90 and 90
          and "street3d_scene_versions"."bounds_west" between -180 and 180 and "street3d_scene_versions"."bounds_east" between -180 and 180),
	CONSTRAINT "street3d_versions_observed_check" CHECK ("street3d_scene_versions"."observed_from" <= "street3d_scene_versions"."observed_to"),
	CONSTRAINT "street3d_versions_digest_check" CHECK ("street3d_scene_versions"."result_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "street3d_versions_assets_check" CHECK (jsonb_typeof("street3d_scene_versions"."assets") = 'array'),
	CONSTRAINT "street3d_versions_navigation_check" CHECK ("street3d_scene_versions"."navigation" is null or coalesce(jsonb_typeof("street3d_scene_versions"."navigation" -> 'viewpoints') = 'array', false)),
	CONSTRAINT "street3d_versions_published_check" CHECK ("street3d_scene_versions"."state" not in ('published', 'superseded') or "street3d_scene_versions"."published_at" is not null),
	CONSTRAINT "street3d_versions_disabled_check" CHECK (("street3d_scene_versions"."state" = 'disabled') = ("street3d_scene_versions"."disabled_at" is not null)),
	CONSTRAINT "street3d_versions_disabled_reason_check" CHECK (("street3d_scene_versions"."disabled_at" is null) = ("street3d_scene_versions"."disabled_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "street3d_scenes" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"anchor_latitude" double precision NOT NULL,
	"anchor_longitude" double precision NOT NULL,
	"anchor_geo" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(anchor_longitude, anchor_latitude), 4326)::geography) STORED,
	"radius_meters" double precision NOT NULL,
	"current_version_id" text,
	"last_allocated_version" integer DEFAULT 0 NOT NULL,
	"last_queued_input_fingerprint" text,
	"eligible_frames" integer DEFAULT 0 NOT NULL,
	"heading_sectors" integer DEFAULT 0 NOT NULL,
	"confidence" double precision,
	"rebuild_requested_at" timestamp with time zone,
	"rebuild_profile" text,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "street3d_scenes_state_check" CHECK ("street3d_scenes"."state" in ('candidate', 'queued', 'reconstructing', 'needs_more_capture', 'failed_quality', 'published', 'disabled')),
	CONSTRAINT "street3d_scenes_rebuild_profile_check" CHECK ("street3d_scenes"."rebuild_profile" in ('draft', 'standard')),
	CONSTRAINT "street3d_scenes_latitude_range_check" CHECK ("street3d_scenes"."anchor_latitude" between -90 and 90),
	CONSTRAINT "street3d_scenes_longitude_range_check" CHECK ("street3d_scenes"."anchor_longitude" between -180 and 180),
	CONSTRAINT "street3d_scenes_radius_check" CHECK ("street3d_scenes"."radius_meters" > 0 and "street3d_scenes"."radius_meters" <= 1000),
	CONSTRAINT "street3d_scenes_counts_check" CHECK ("street3d_scenes"."eligible_frames" >= 0 and "street3d_scenes"."heading_sectors" between 0 and 8),
	CONSTRAINT "street3d_scenes_confidence_check" CHECK ("street3d_scenes"."confidence" is null or "street3d_scenes"."confidence" between 0 and 1),
	CONSTRAINT "street3d_scenes_version_counter_check" CHECK ("street3d_scenes"."last_allocated_version" >= 0),
	CONSTRAINT "street3d_scenes_fingerprint_check" CHECK ("street3d_scenes"."last_queued_input_fingerprint" is null or "street3d_scenes"."last_queued_input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "street3d_scenes_disabled_check" CHECK (("street3d_scenes"."disabled_at" is null) = ("street3d_scenes"."disabled_reason" is null)),
	CONSTRAINT "street3d_scenes_disabled_state_check" CHECK (("street3d_scenes"."state" = 'disabled') = ("street3d_scenes"."disabled_at" is not null)),
	CONSTRAINT "street3d_scenes_published_check" CHECK ("street3d_scenes"."state" <> 'published' or "street3d_scenes"."current_version_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD COLUMN "attribution" text;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD CONSTRAINT "capture_derivatives_asset_id_capture_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."capture_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD CONSTRAINT "capture_derivatives_job_id_street3d_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."street3d_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_capture_blocks" ADD CONSTRAINT "street3d_capture_blocks_capture_asset_id_capture_assets_id_fk" FOREIGN KEY ("capture_asset_id") REFERENCES "public"."capture_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_capture_edges" ADD CONSTRAINT "street3d_capture_edges_derivative_a_capture_derivatives_id_fk" FOREIGN KEY ("derivative_a") REFERENCES "public"."capture_derivatives"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_capture_edges" ADD CONSTRAINT "street3d_capture_edges_derivative_b_capture_derivatives_id_fk" FOREIGN KEY ("derivative_b") REFERENCES "public"."capture_derivatives"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_capture_edges" ADD CONSTRAINT "street3d_capture_edges_observed_in_version_id_street3d_scene_versions_id_fk" FOREIGN KEY ("observed_in_version_id") REFERENCES "public"."street3d_scene_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_coverage_areas" ADD CONSTRAINT "street3d_coverage_areas_scene_id_street3d_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."street3d_scenes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_job_events" ADD CONSTRAINT "street3d_job_events_job_id_street3d_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."street3d_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_jobs" ADD CONSTRAINT "street3d_jobs_asset_id_capture_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."capture_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_jobs" ADD CONSTRAINT "street3d_jobs_scene_id_street3d_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."street3d_scenes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_inputs" ADD CONSTRAINT "street3d_scene_inputs_version_id_street3d_scene_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."street3d_scene_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_inputs" ADD CONSTRAINT "street3d_scene_inputs_capture_asset_id_capture_assets_id_fk" FOREIGN KEY ("capture_asset_id") REFERENCES "public"."capture_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_inputs" ADD CONSTRAINT "street3d_scene_inputs_derivative_id_capture_derivatives_id_fk" FOREIGN KEY ("derivative_id") REFERENCES "public"."capture_derivatives"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_reports" ADD CONSTRAINT "street3d_scene_reports_scene_id_street3d_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."street3d_scenes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_reports" ADD CONSTRAINT "street3d_scene_reports_version_id_street3d_scene_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."street3d_scene_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_scene_versions_scene_id_street3d_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."street3d_scenes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_scene_versions_job_id_street3d_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."street3d_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "street3d_scenes" ADD CONSTRAINT "street3d_scenes_current_version_id_street3d_scene_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."street3d_scene_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_derivatives_asset_idx" ON "capture_derivatives" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "capture_derivatives_expiry_idx" ON "capture_derivatives" USING btree ("expires_at") WHERE "capture_derivatives"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "street3d_capture_blocks_hash_idx" ON "street3d_capture_blocks" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "street3d_capture_edges_b_idx" ON "street3d_capture_edges" USING btree ("derivative_b");--> statement-breakpoint
CREATE INDEX "street3d_coverage_center_idx" ON "street3d_coverage_areas" USING btree ("center_latitude","center_longitude");--> statement-breakpoint
CREATE INDEX "street3d_job_events_job_idx" ON "street3d_job_events" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "street3d_jobs_open_asset_key" ON "street3d_jobs" USING btree ("asset_id") WHERE "street3d_jobs"."asset_id" is not null and "street3d_jobs"."state" not in ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "street3d_jobs_open_scene_key" ON "street3d_jobs" USING btree ("scene_id") WHERE "street3d_jobs"."scene_id" is not null and "street3d_jobs"."state" not in ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "street3d_jobs_scene_version_key" ON "street3d_jobs" USING btree ("scene_id","scene_version") WHERE "street3d_jobs"."scene_id" is not null;--> statement-breakpoint
CREATE INDEX "street3d_jobs_state_idx" ON "street3d_jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "street3d_jobs_dispatch_idx" ON "street3d_jobs" USING btree ("enqueued_at") WHERE "street3d_jobs"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "street3d_jobs_finished_idx" ON "street3d_jobs" USING btree ("finished_at") WHERE "street3d_jobs"."artifacts_deleted_at" is null;--> statement-breakpoint
CREATE INDEX "street3d_scene_inputs_asset_idx" ON "street3d_scene_inputs" USING btree ("capture_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "street3d_reports_open_key" ON "street3d_scene_reports" USING btree ("version_id","reporter_oxy_user_id") WHERE "street3d_scene_reports"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "street3d_reports_open_idx" ON "street3d_scene_reports" USING btree ("scene_id") WHERE "street3d_scene_reports"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "street3d_versions_published_key" ON "street3d_scene_versions" USING btree ("scene_id") WHERE "street3d_scene_versions"."state" = 'published';--> statement-breakpoint
CREATE INDEX "street3d_versions_bounds_idx" ON "street3d_scene_versions" USING btree ("bounds_west","bounds_south","bounds_east","bounds_north");--> statement-breakpoint
CREATE INDEX "street3d_scenes_geo_gist" ON "street3d_scenes" USING gist ("anchor_geo");--> statement-breakpoint
CREATE INDEX "street3d_scenes_state_idx" ON "street3d_scenes" USING btree ("state");--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_attribution_check" CHECK ("capture_sessions"."attribution" is null or (btrim("capture_sessions"."attribution") <> '' and char_length("capture_sessions"."attribution") <= 200));