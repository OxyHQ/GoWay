-- oxy:deploy-phase=pre
--
-- GoWay Street 3D capture (issues #9 and #10): contributed imagery, where it
-- is, why it is stored and when it dies.
--
-- `pre`, and it is genuinely additive: five new tables, their constraints and
-- their indexes. Nothing is dropped, renamed or narrowed, so this is correct
-- against the image still serving AND the one arriving, and it must be applied
-- BEFORE the rollout — the new image's capture routes cannot answer a single
-- request without these tables.
--
-- POSTGIS IS A PRECONDITION OF THIS FILE, NOT PART OF IT, exactly as it is for
-- `0000`. `capture_assets.anchor_geo` names the `geography` type and
-- `capture_assets.geo_cell` calls `ST_GeoHash`, so on a database without the
-- extension the CREATE TABLE fails outright. `src/db/extensions.ts` declares it
-- and `bun run db:migrate` ensures it before any DDL runs.
--
-- The two constraints worth reading before changing anything here:
--
--   `capture_objects_expiry_ceiling_check` — with `expires_at`,
--   `retention_class` and `retention_reason` NOT NULL, this is what makes a
--   permanent raw upload impossible to INSERT rather than merely unlikely.
--
--   `capture_objects_live_content_hash_key` — a PARTIAL unique index, on
--   `deleted_at is null`. Exact deduplication that still lets identical bytes
--   be contributed again after the first object has expired and been deleted.
--
CREATE TABLE "capture_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"media_object_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"media_kind" text NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'expected' NOT NULL,
	"captured_at" timestamp with time zone,
	"anchor_latitude" double precision NOT NULL,
	"anchor_longitude" double precision NOT NULL,
	"anchor_geo" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(anchor_longitude, anchor_latitude), 4326)::geography) STORED,
	"geo_cell" text GENERATED ALWAYS AS (ST_GeoHash(ST_SetSRID(ST_MakePoint(anchor_longitude, anchor_latitude), 4326), 9)) STORED,
	"anchor_origin" text NOT NULL,
	"anchor_witness" text NOT NULL,
	"anchor_accuracy_meters" double precision,
	"privacy_state" text DEFAULT 'pending' NOT NULL,
	"privacy_pipeline_version" text,
	"privacy_completed_at" timestamp with time zone,
	"reconstruction_eligible" boolean GENERATED ALWAYS AS (privacy_state = 'passed' and privacy_pipeline_version is not null and state in ('accepted', 'waiting_for_overlap', 'reconstruction_candidate', 'integrated')) STORED NOT NULL,
	"camera_width_pixels" integer,
	"camera_height_pixels" integer,
	"exif_orientation" integer,
	"focal_length_mm" double precision,
	"focal_length_equivalent_mm" double precision,
	"camera_make" text,
	"camera_model" text,
	"camera_lens" text,
	"duration_seconds" double precision,
	"frame_rate" double precision,
	"quality_score" double precision,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_assets_media_kind_check" CHECK ("capture_assets"."media_kind" in ('photo', 'video')),
	CONSTRAINT "capture_assets_source_check" CHECK ("capture_assets"."source" in ('camera', 'library', 'guided_session')),
	CONSTRAINT "capture_assets_state_check" CHECK ("capture_assets"."state" in ('expected', 'abandoned', 'uploaded', 'validating', 'accepted', 'rejected', 'waiting_for_overlap', 'reconstruction_candidate', 'integrated', 'expired', 'deleted')),
	CONSTRAINT "capture_assets_anchor_origin_check" CHECK ("capture_assets"."anchor_origin" in ('device_capture', 'media_metadata', 'user_placed')),
	CONSTRAINT "capture_assets_anchor_witness_check" CHECK ("capture_assets"."anchor_witness" in ('client', 'goway_ingest')),
	CONSTRAINT "capture_assets_privacy_state_check" CHECK ("capture_assets"."privacy_state" in ('pending', 'in_progress', 'passed', 'failed', 'blocked')),
	CONSTRAINT "capture_assets_latitude_range_check" CHECK ("capture_assets"."anchor_latitude" between -90 and 90),
	CONSTRAINT "capture_assets_longitude_range_check" CHECK ("capture_assets"."anchor_longitude" between -180 and 180),
	CONSTRAINT "capture_assets_accuracy_check" CHECK ("capture_assets"."anchor_accuracy_meters" is null or "capture_assets"."anchor_accuracy_meters" >= 0),
	CONSTRAINT "capture_assets_user_placed_witness_check" CHECK ("capture_assets"."anchor_origin" <> 'user_placed' or "capture_assets"."anchor_witness" = 'client'),
	CONSTRAINT "capture_assets_privacy_gate_check" CHECK ("capture_assets"."state" not in ('reconstruction_candidate', 'integrated') or "capture_assets"."privacy_state" = 'passed'),
	CONSTRAINT "capture_assets_privacy_version_check" CHECK ("capture_assets"."privacy_state" <> 'passed' or "capture_assets"."privacy_pipeline_version" is not null),
	CONSTRAINT "capture_assets_privacy_completed_check" CHECK (("capture_assets"."privacy_state" in ('passed', 'failed', 'blocked')) = ("capture_assets"."privacy_completed_at" is not null)),
	CONSTRAINT "capture_assets_exif_orientation_check" CHECK ("capture_assets"."exif_orientation" is null or "capture_assets"."exif_orientation" between 1 and 8),
	CONSTRAINT "capture_assets_pixels_check" CHECK (("capture_assets"."camera_width_pixels" is null or "capture_assets"."camera_width_pixels" > 0)
          and ("capture_assets"."camera_height_pixels" is null or "capture_assets"."camera_height_pixels" > 0)),
	CONSTRAINT "capture_assets_focal_length_check" CHECK (("capture_assets"."focal_length_mm" is null or "capture_assets"."focal_length_mm" > 0)
          and ("capture_assets"."focal_length_equivalent_mm" is null or "capture_assets"."focal_length_equivalent_mm" > 0)),
	CONSTRAINT "capture_assets_video_fields_check" CHECK ("capture_assets"."media_kind" = 'video' or ("capture_assets"."duration_seconds" is null and "capture_assets"."frame_rate" is null)),
	CONSTRAINT "capture_assets_duration_check" CHECK (("capture_assets"."duration_seconds" is null or "capture_assets"."duration_seconds" > 0)
          and ("capture_assets"."frame_rate" is null or "capture_assets"."frame_rate" > 0)),
	CONSTRAINT "capture_assets_quality_score_check" CHECK ("capture_assets"."quality_score" is null or "capture_assets"."quality_score" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "capture_location_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"origin" text NOT NULL,
	"witness" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_meters" double precision,
	"altitude_meters" double precision,
	"heading_degrees" double precision,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_evidence_assertion_key" UNIQUE("asset_id","origin","witness"),
	CONSTRAINT "capture_evidence_origin_check" CHECK ("capture_location_evidence"."origin" in ('device_capture', 'media_metadata', 'user_placed')),
	CONSTRAINT "capture_evidence_witness_check" CHECK ("capture_location_evidence"."witness" in ('client', 'goway_ingest')),
	CONSTRAINT "capture_evidence_latitude_range_check" CHECK ("capture_location_evidence"."latitude" between -90 and 90),
	CONSTRAINT "capture_evidence_longitude_range_check" CHECK ("capture_location_evidence"."longitude" between -180 and 180),
	CONSTRAINT "capture_evidence_accuracy_check" CHECK ("capture_location_evidence"."accuracy_meters" is null or "capture_location_evidence"."accuracy_meters" >= 0),
	CONSTRAINT "capture_evidence_heading_check" CHECK ("capture_location_evidence"."heading_degrees" is null or ("capture_location_evidence"."heading_degrees" >= 0 and "capture_location_evidence"."heading_degrees" < 360)),
	CONSTRAINT "capture_evidence_user_placed_witness_check" CHECK ("capture_location_evidence"."origin" <> 'user_placed' or "capture_location_evidence"."witness" = 'client')
);
--> statement-breakpoint
CREATE TABLE "capture_media_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"confirmed_byte_size" bigint,
	"storage_state" text DEFAULT 'expected' NOT NULL,
	"upload_intent_expires_at" timestamp with time zone NOT NULL,
	"stored_at" timestamp with time zone,
	"retention_class" text NOT NULL,
	"retention_reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deletion_eligible_at" timestamp with time zone,
	"protected_until" timestamp with time zone,
	"retention_extension_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deletion_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_objects_object_key_key" UNIQUE("object_key"),
	CONSTRAINT "capture_objects_storage_state_check" CHECK ("capture_media_objects"."storage_state" in ('expected', 'stored', 'deleting', 'deleted')),
	CONSTRAINT "capture_objects_retention_class_check" CHECK ("capture_media_objects"."retention_class" in ('raw_photo', 'raw_video', 'extracted_keyframe', 'privacy_safe_proxy', 'thumbnail')),
	CONSTRAINT "capture_objects_retention_reason_check" CHECK ("capture_media_objects"."retention_reason" in ('awaiting_privacy_processing', 'awaiting_overlap', 'reconstruction_input', 'derivation_source', 'audit_window', 'rescue_extension', 'published_artifact')),
	CONSTRAINT "capture_objects_deletion_reason_check" CHECK ("capture_media_objects"."deletion_reason" in ('expired', 'contributor_request', 'moderation', 'duplicate', 'invalid_media', 'superseded_by_derivative')),
	CONSTRAINT "capture_objects_content_hash_check" CHECK ("capture_media_objects"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "capture_objects_object_key_check" CHECK (btrim("capture_media_objects"."object_key") <> ''),
	CONSTRAINT "capture_objects_byte_size_check" CHECK ("capture_media_objects"."byte_size" > 0),
	CONSTRAINT "capture_objects_confirmed_byte_size_check" CHECK ("capture_media_objects"."confirmed_byte_size" is null or "capture_media_objects"."confirmed_byte_size" > 0),
	CONSTRAINT "capture_objects_expiry_after_creation_check" CHECK ("capture_media_objects"."expires_at" > "capture_media_objects"."created_at"),
	CONSTRAINT "capture_objects_expiry_ceiling_check" CHECK ("capture_media_objects"."expires_at" <= "capture_media_objects"."created_at" + interval '400 days'),
	CONSTRAINT "capture_objects_deletion_eligible_check" CHECK ("capture_media_objects"."deletion_eligible_at" is null or "capture_media_objects"."deletion_eligible_at" <= "capture_media_objects"."expires_at"),
	CONSTRAINT "capture_objects_protected_until_check" CHECK ("capture_media_objects"."protected_until" is null or "capture_media_objects"."protected_until" <= "capture_media_objects"."expires_at"),
	CONSTRAINT "capture_objects_extension_count_check" CHECK ("capture_media_objects"."retention_extension_count" between 0 and 3),
	CONSTRAINT "capture_objects_tombstone_check" CHECK (("capture_media_objects"."deleted_at" is null) = ("capture_media_objects"."deletion_reason" is null)),
	CONSTRAINT "capture_objects_deleted_state_check" CHECK (("capture_media_objects"."storage_state" = 'deleted') = ("capture_media_objects"."deleted_at" is not null)),
	CONSTRAINT "capture_objects_stored_at_present_check" CHECK ("capture_media_objects"."storage_state" not in ('stored', 'deleting') or "capture_media_objects"."stored_at" is not null),
	CONSTRAINT "capture_objects_stored_at_absent_check" CHECK ("capture_media_objects"."storage_state" <> 'expected' or "capture_media_objects"."stored_at" is null)
);
--> statement-breakpoint
CREATE TABLE "capture_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"source" text NOT NULL,
	"consent_version" text NOT NULL,
	"note" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_sessions_source_check" CHECK ("capture_sessions"."source" in ('camera', 'library', 'guided_session')),
	CONSTRAINT "capture_sessions_consent_version_check" CHECK (btrim("capture_sessions"."consent_version") <> ''),
	CONSTRAINT "capture_sessions_ended_at_check" CHECK ("capture_sessions"."ended_at" is null or "capture_sessions"."ended_at" >= "capture_sessions"."started_at")
);
--> statement-breakpoint
CREATE TABLE "capture_storage_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"retention_class" text,
	"byte_ceiling" bigint NOT NULL,
	"note" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_budgets_scope_key" UNIQUE NULLS NOT DISTINCT("scope","scope_key","retention_class"),
	CONSTRAINT "capture_budgets_scope_check" CHECK ("capture_storage_budgets"."scope" in ('global', 'contributor', 'geo_cell')),
	CONSTRAINT "capture_budgets_retention_class_check" CHECK ("capture_storage_budgets"."retention_class" in ('raw_photo', 'raw_video', 'extracted_keyframe', 'privacy_safe_proxy', 'thumbnail')),
	CONSTRAINT "capture_budgets_byte_ceiling_check" CHECK ("capture_storage_budgets"."byte_ceiling" > 0),
	CONSTRAINT "capture_budgets_scope_key_check" CHECK (("capture_storage_budgets"."scope" = 'global') = ("capture_storage_budgets"."scope_key" = '')),
	CONSTRAINT "capture_budgets_effective_window_check" CHECK ("capture_storage_budgets"."effective_until" is null or "capture_storage_budgets"."effective_until" > "capture_storage_budgets"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "capture_assets" ADD CONSTRAINT "capture_assets_session_id_capture_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."capture_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_assets" ADD CONSTRAINT "capture_assets_media_object_id_capture_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."capture_media_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_location_evidence" ADD CONSTRAINT "capture_location_evidence_asset_id_capture_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."capture_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_assets_geo_gist" ON "capture_assets" USING gist ("anchor_geo");--> statement-breakpoint
CREATE INDEX "capture_assets_geo_cell_idx" ON "capture_assets" USING btree ("geo_cell" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "capture_assets_session_idx" ON "capture_assets" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "capture_assets_media_object_idx" ON "capture_assets" USING btree ("media_object_id");--> statement-breakpoint
CREATE INDEX "capture_assets_contributor_idx" ON "capture_assets" USING btree ("oxy_user_id","created_at");--> statement-breakpoint
CREATE INDEX "capture_assets_state_idx" ON "capture_assets" USING btree ("state");--> statement-breakpoint
CREATE INDEX "capture_assets_privacy_pending_idx" ON "capture_assets" USING btree ("privacy_state") WHERE "capture_assets"."privacy_state" in ('pending', 'in_progress', 'failed');--> statement-breakpoint
CREATE INDEX "capture_evidence_asset_idx" ON "capture_location_evidence" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_objects_live_content_hash_key" ON "capture_media_objects" USING btree ("content_hash") WHERE "capture_media_objects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "capture_objects_expiry_idx" ON "capture_media_objects" USING btree ("expires_at") WHERE "capture_media_objects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "capture_objects_orphan_idx" ON "capture_media_objects" USING btree ("upload_intent_expires_at") WHERE "capture_media_objects"."storage_state" = 'expected';--> statement-breakpoint
CREATE INDEX "capture_objects_storage_state_idx" ON "capture_media_objects" USING btree ("storage_state");--> statement-breakpoint
CREATE INDEX "capture_objects_retention_class_idx" ON "capture_media_objects" USING btree ("retention_class");--> statement-breakpoint
CREATE INDEX "capture_sessions_contributor_idx" ON "capture_sessions" USING btree ("oxy_user_id","started_at");