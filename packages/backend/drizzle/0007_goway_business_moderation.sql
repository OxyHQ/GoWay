-- oxy:deploy-phase=pre
CREATE TABLE "place_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"reporter_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolved_by_oxy_user_id" text,
	CONSTRAINT "place_reports_reason_check" CHECK ("place_reports"."reason" in ('does_not_exist', 'permanently_closed', 'wrong_location', 'wrong_details', 'duplicate', 'spam', 'offensive', 'privacy')),
	CONSTRAINT "place_reports_resolution_check" CHECK ("place_reports"."resolution" is null or "place_reports"."resolution" in ('actioned', 'dismissed')),
	CONSTRAINT "place_reports_resolved_check" CHECK (("place_reports"."resolved_at" is null) = ("place_reports"."resolution" is null) and ("place_reports"."resolved_at" is null) = ("place_reports"."resolved_by_oxy_user_id" is null)),
	CONSTRAINT "place_reports_note_check" CHECK ("place_reports"."note" is null or char_length("place_reports"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "place_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"oxy_account_id" text NOT NULL,
	"operated_by_oxy_user_id" text,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_revisions_action_check" CHECK ("place_revisions"."action" in ('place_created', 'place_updated', 'capability_asserted', 'capability_withdrawn', 'claim_requested', 'claim_approved', 'claim_rejected', 'claim_revoked', 'place_merged', 'place_absorbed', 'duplicate_rejected', 'report_resolved')),
	CONSTRAINT "place_revisions_source_check" CHECK ("place_revisions"."source" in ('api', 'moderation')),
	CONSTRAINT "place_revisions_changes_array_check" CHECK (jsonb_typeof("place_revisions"."changes") = 'array')
);
--> statement-breakpoint
ALTER TABLE "places" DROP CONSTRAINT "places_status_check";--> statement-breakpoint
DROP INDEX "places_duplicates_state_idx";--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "merged_into_place_id" text;--> statement-breakpoint
ALTER TABLE "place_reports" ADD CONSTRAINT "place_reports_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_revisions" ADD CONSTRAINT "place_revisions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "place_reports_open_key" ON "place_reports" USING btree ("place_id","reporter_oxy_user_id") WHERE "place_reports"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "place_reports_queue_idx" ON "place_reports" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "place_revisions_place_created_idx" ON "place_revisions" USING btree ("place_id","created_at","id");--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_merged_into_place_id_places_id_fk" FOREIGN KEY ("merged_into_place_id") REFERENCES "public"."places"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "places_merged_into_idx" ON "places" USING btree ("merged_into_place_id");--> statement-breakpoint
CREATE INDEX "places_claims_state_claimed_idx" ON "places_claims" USING btree ("state","claimed_at");--> statement-breakpoint
CREATE INDEX "places_duplicates_state_idx" ON "places_duplicate_candidates" USING btree ("state","created_at");--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_merged_into_check" CHECK (("places"."status" = 'merged') = ("places"."merged_into_place_id" is not null));--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_merged_into_self_check" CHECK ("places"."merged_into_place_id" <> "places"."id");--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_status_check" CHECK ("places"."status" in ('active', 'closed', 'proposed', 'removed', 'merged'));