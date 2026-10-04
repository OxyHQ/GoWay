-- oxy:deploy-phase=pre
ALTER TABLE "capture_media_objects" DROP CONSTRAINT "capture_objects_stored_at_present_check";--> statement-breakpoint
ALTER TABLE "capture_media_objects" ADD CONSTRAINT "capture_objects_stored_at_present_check" CHECK ("capture_media_objects"."storage_state" <> 'stored' or "capture_media_objects"."stored_at" is not null);
