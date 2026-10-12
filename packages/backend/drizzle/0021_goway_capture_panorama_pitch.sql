-- oxy:deploy-phase=pre
ALTER TABLE "capture_derivatives" ADD COLUMN "panorama_pitch_degrees" double precision;--> statement-breakpoint
ALTER TABLE "capture_derivatives" ADD CONSTRAINT "capture_derivatives_panorama_pitch_check" CHECK ("capture_derivatives"."panorama_pitch_degrees" is null
          or coalesce("capture_derivatives"."panorama_index" is not null
              and "capture_derivatives"."panorama_pitch_degrees" >= -90 and "capture_derivatives"."panorama_pitch_degrees" <= 90, false));