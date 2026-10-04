-- oxy:deploy-phase=pre
ALTER TABLE "capture_assets" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "capture_assets" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "capture_assets" ADD CONSTRAINT "capture_assets_session_request_key" UNIQUE("session_id","idempotency_key");
