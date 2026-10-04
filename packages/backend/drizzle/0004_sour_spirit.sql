-- oxy:deploy-phase=pre
ALTER TABLE "capture_media_objects" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "capture_media_objects" ADD COLUMN "deletion_requested_reason" text;--> statement-breakpoint
ALTER TABLE "capture_media_objects" ADD CONSTRAINT "capture_objects_deletion_requested_reason_check" CHECK ("capture_media_objects"."deletion_requested_reason" in ('expired', 'contributor_request', 'moderation', 'duplicate', 'invalid_media', 'superseded_by_derivative'));--> statement-breakpoint
ALTER TABLE "capture_media_objects" ADD CONSTRAINT "capture_objects_deletion_request_check" CHECK (("capture_media_objects"."deletion_requested_at" is null) = ("capture_media_objects"."deletion_requested_reason" is null));
