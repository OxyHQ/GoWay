-- oxy:deploy-phase=pre
ALTER TABLE "capture_assets" ADD COLUMN "projection" text DEFAULT 'perspective' NOT NULL;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD COLUMN "panorama_index" integer;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD COLUMN "panorama_yaw_degrees" double precision;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD COLUMN "panorama_fov_degrees" double precision;--> statement-breakpoint
ALTER TABLE "capture_assets" ADD CONSTRAINT "capture_assets_projection_check" CHECK ("capture_assets"."projection" in ('perspective', 'equirectangular'));--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD CONSTRAINT "capture_derivatives_panorama_check" CHECK (("capture_derivatives"."panorama_index" is null and "capture_derivatives"."panorama_yaw_degrees" is null and "capture_derivatives"."panorama_fov_degrees" is null)
          or coalesce("capture_derivatives"."panorama_index" >= 0 and "capture_derivatives"."panorama_yaw_degrees" >= 0 and "capture_derivatives"."panorama_yaw_degrees" < 360
              and "capture_derivatives"."panorama_fov_degrees" > 0 and "capture_derivatives"."panorama_fov_degrees" < 180, false));