-- oxy:deploy-phase=pre
ALTER TABLE "street3d_scene_versions" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD COLUMN "source" text DEFAULT 'reconstruction' NOT NULL;--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD COLUMN "licence" jsonb;--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD COLUMN "privacy_attestation" jsonb;--> statement-breakpoint
ALTER TABLE "street3d_scenes" ADD COLUMN "source" text DEFAULT 'reconstruction' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "street3d_versions_import_key" ON "street3d_scene_versions" USING btree ("result_sha256") WHERE "street3d_scene_versions"."source" = 'licensed_import';--> statement-breakpoint
ALTER TABLE "street3d_scenes" ADD CONSTRAINT "street3d_scenes_id_source_key" UNIQUE("id","source");--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_versions_source_check" CHECK ("street3d_scene_versions"."source" in ('reconstruction', 'licensed_import'));--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_versions_job_source_check" CHECK (("street3d_scene_versions"."source" = 'reconstruction') = ("street3d_scene_versions"."job_id" is not null));--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_versions_licence_check" CHECK (("street3d_scene_versions"."source" = 'licensed_import') = ("street3d_scene_versions"."licence" is not null)
          and ("street3d_scene_versions"."licence" is null or jsonb_typeof("street3d_scene_versions"."licence") = 'object'));--> statement-breakpoint
ALTER TABLE "street3d_scene_versions" ADD CONSTRAINT "street3d_versions_privacy_attestation_check" CHECK (("street3d_scene_versions"."source" = 'licensed_import') = ("street3d_scene_versions"."privacy_attestation" is not null)
          and ("street3d_scene_versions"."privacy_attestation" is null
               or coalesce("street3d_scene_versions"."privacy_attestation" ->> 'basis' in ('licensor_redacted', 'goway_splat_review'), false))
          and ("street3d_scene_versions"."source" <> 'licensed_import' or cardinality("street3d_scene_versions"."privacy_pipeline_versions") = 0));--> statement-breakpoint
ALTER TABLE "street3d_scenes" ADD CONSTRAINT "street3d_scenes_source_check" CHECK ("street3d_scenes"."source" in ('reconstruction', 'licensed_import'));--> statement-breakpoint
ALTER TABLE "street3d_scenes" ADD CONSTRAINT "street3d_scenes_import_check" CHECK ("street3d_scenes"."source" = 'reconstruction'
          or ("street3d_scenes"."state" in ('candidate', 'published', 'disabled')
              and "street3d_scenes"."last_queued_input_fingerprint" is null
              and "street3d_scenes"."rebuild_requested_at" is null and "street3d_scenes"."rebuild_profile" is null));
