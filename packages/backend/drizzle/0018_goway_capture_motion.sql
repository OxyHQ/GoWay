-- oxy:deploy-phase=pre
CREATE TABLE "capture_motion_tracks" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"orientation" text NOT NULL,
	"sample_seconds" double precision[] NOT NULL,
	"gravity_x" double precision[] NOT NULL,
	"gravity_y" double precision[] NOT NULL,
	"gravity_z" double precision[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "capture_motion_tracks_orientation_check" CHECK ("capture_motion_tracks"."orientation" in ('portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight')),
	CONSTRAINT "capture_motion_tracks_samples_check" CHECK (cardinality("capture_motion_tracks"."sample_seconds") between 1 and 14400
          and cardinality("capture_motion_tracks"."gravity_x") = cardinality("capture_motion_tracks"."sample_seconds")
          and cardinality("capture_motion_tracks"."gravity_y") = cardinality("capture_motion_tracks"."sample_seconds")
          and cardinality("capture_motion_tracks"."gravity_z") = cardinality("capture_motion_tracks"."sample_seconds"))
);
--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD COLUMN "gravity_x" double precision;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD COLUMN "gravity_y" double precision;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD COLUMN "gravity_z" double precision;--> statement-breakpoint
ALTER TABLE "capture_motion_tracks" ADD CONSTRAINT "capture_motion_tracks_asset_id_capture_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."capture_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD CONSTRAINT "capture_derivatives_gravity_check" CHECK (("capture_derivatives"."gravity_x" is null and "capture_derivatives"."gravity_y" is null and "capture_derivatives"."gravity_z" is null)
          or coalesce(abs(sqrt("capture_derivatives"."gravity_x" ^ 2 + "capture_derivatives"."gravity_y" ^ 2 + "capture_derivatives"."gravity_z" ^ 2) - 1) <= 0.01, false));