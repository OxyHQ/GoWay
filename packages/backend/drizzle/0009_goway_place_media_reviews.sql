-- oxy:deploy-phase=pre
-- Place media, reviews and descriptions (docs/PLACE_MEDIA_REVIEWS.md): new
-- tables, nullable columns, report subjects, a uniqueness WIDENED from one
-- open report per place to one per subject, and widened CHECKs. All of it is
-- correct against the image still serving, and it precedes every post
-- migration of the release (drizzle/README.md).
CREATE TABLE "place_media" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"oxy_file_id" text NOT NULL,
	"oxy_link_place_id" text NOT NULL,
	"kind" text NOT NULL,
	"contributor_oxy_account_id" text NOT NULL,
	"operated_by_oxy_user_id" text,
	"verification" text NOT NULL,
	"state" text DEFAULT 'visible' NOT NULL,
	"position" integer NOT NULL,
	"caption" text,
	"attribution" text,
	"license" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_media_kind_check" CHECK ("place_media"."kind" in ('photo', 'logo', 'cover', 'menu', 'interior', 'exterior')),
	CONSTRAINT "place_media_state_check" CHECK ("place_media"."state" in ('visible', 'hidden', 'removed')),
	CONSTRAINT "place_media_verification_check" CHECK ("place_media"."verification" in ('community_reported', 'external_source', 'business_asserted', 'oxy_verified')),
	CONSTRAINT "place_media_position_check" CHECK ("place_media"."position" >= 0),
	CONSTRAINT "place_media_caption_check" CHECK ("place_media"."caption" is null or char_length("place_media"."caption") <= 280),
	CONSTRAINT "place_media_dimensions_check" CHECK (("place_media"."width" is null or "place_media"."width" > 0) and ("place_media"."height" is null or "place_media"."height" > 0)),
	CONSTRAINT "place_media_external_source_check" CHECK ("place_media"."verification" <> 'external_source' or ("place_media"."attribution" is not null and "place_media"."license" is not null)),
	CONSTRAINT "place_media_file_not_blank_check" CHECK (btrim("place_media"."oxy_file_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "place_review_aggregates" (
	"place_id" text PRIMARY KEY NOT NULL,
	"review_count" integer NOT NULL,
	"rating_average" numeric(4, 3),
	"rating1" integer NOT NULL,
	"rating2" integer NOT NULL,
	"rating3" integer NOT NULL,
	"rating4" integer NOT NULL,
	"rating5" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_review_aggregates_count_check" CHECK ("place_review_aggregates"."review_count" >= 0),
	CONSTRAINT "place_review_aggregates_average_check" CHECK (("place_review_aggregates"."review_count" = 0) = ("place_review_aggregates"."rating_average" is null)),
	CONSTRAINT "place_review_aggregates_distribution_check" CHECK ("place_review_aggregates"."rating1" + "place_review_aggregates"."rating2" + "place_review_aggregates"."rating3" + "place_review_aggregates"."rating4" + "place_review_aggregates"."rating5" = "place_review_aggregates"."review_count")
);
--> statement-breakpoint
CREATE TABLE "place_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"title" text,
	"body" text,
	"locale" text,
	"status" text DEFAULT 'published' NOT NULL,
	"edited_at" timestamp with time zone,
	"reply_body" text,
	"reply_oxy_account_id" text,
	"reply_operated_by_oxy_user_id" text,
	"replied_at" timestamp with time zone,
	"reply_edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_reviews_status_check" CHECK ("place_reviews"."status" in ('published', 'hidden', 'removed')),
	CONSTRAINT "place_reviews_rating_check" CHECK ("place_reviews"."rating" between 1 and 5),
	CONSTRAINT "place_reviews_title_check" CHECK ("place_reviews"."title" is null or (btrim("place_reviews"."title") <> '' and char_length("place_reviews"."title") <= 120)),
	CONSTRAINT "place_reviews_body_check" CHECK ("place_reviews"."body" is null or (btrim("place_reviews"."body") <> '' and char_length("place_reviews"."body") <= 4000)),
	CONSTRAINT "place_reviews_locale_check" CHECK ("place_reviews"."locale" is null or "place_reviews"."locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$'),
	CONSTRAINT "place_reviews_removed_erased_check" CHECK ("place_reviews"."status" <> 'removed' or ("place_reviews"."title" is null and "place_reviews"."body" is null and "place_reviews"."reply_body" is null)),
	CONSTRAINT "place_reviews_reply_check" CHECK (("place_reviews"."reply_body" is null) = ("place_reviews"."replied_at" is null) and ("place_reviews"."reply_body" is null) = ("place_reviews"."reply_oxy_account_id" is null)),
	CONSTRAINT "place_reviews_reply_length_check" CHECK ("place_reviews"."reply_body" is null or (btrim("place_reviews"."reply_body") <> '' and char_length("place_reviews"."reply_body") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "places_descriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"language" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_descriptions_language_source_key" UNIQUE("place_id","language","source"),
	CONSTRAINT "places_descriptions_language_tag_check" CHECK ("places_descriptions"."language" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$'),
	CONSTRAINT "places_descriptions_text_check" CHECK (btrim("places_descriptions"."description") <> '' and char_length("places_descriptions"."description") <= 2000),
	CONSTRAINT "places_descriptions_source_not_blank_check" CHECK (btrim("places_descriptions"."source") <> '')
);
--> statement-breakpoint
ALTER TABLE "place_reports" DROP CONSTRAINT "place_reports_reason_check";--> statement-breakpoint
ALTER TABLE "place_revisions" DROP CONSTRAINT "place_revisions_action_check";--> statement-breakpoint
DROP INDEX "place_reports_open_key";--> statement-breakpoint
ALTER TABLE "place_reports" ADD COLUMN "media_id" text;--> statement-breakpoint
ALTER TABLE "place_reports" ADD COLUMN "review_id" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "logo_media_id" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "cover_media_id" text;--> statement-breakpoint
ALTER TABLE "place_media" ADD CONSTRAINT "place_media_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_review_aggregates" ADD CONSTRAINT "place_review_aggregates_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_reviews" ADD CONSTRAINT "place_reviews_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places_descriptions" ADD CONSTRAINT "places_descriptions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "place_media_live_file_key" ON "place_media" USING btree ("place_id","oxy_file_id") WHERE "place_media"."state" <> 'removed';--> statement-breakpoint
CREATE INDEX "place_media_place_position_idx" ON "place_media" USING btree ("place_id","position","id");--> statement-breakpoint
CREATE INDEX "place_media_file_idx" ON "place_media" USING btree ("oxy_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "place_reviews_published_author_key" ON "place_reviews" USING btree ("place_id","author_oxy_user_id") WHERE "place_reviews"."status" = 'published';--> statement-breakpoint
CREATE INDEX "place_reviews_author_idx" ON "place_reviews" USING btree ("author_oxy_user_id","place_id");--> statement-breakpoint
CREATE INDEX "place_reviews_place_created_idx" ON "place_reviews" USING btree ("place_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "place_reviews_place_rating_idx" ON "place_reviews" USING btree ("place_id","status","rating","created_at","id");--> statement-breakpoint
CREATE INDEX "places_descriptions_place_idx" ON "places_descriptions" USING btree ("place_id");--> statement-breakpoint
ALTER TABLE "place_reports" ADD CONSTRAINT "place_reports_media_id_place_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."place_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_reports" ADD CONSTRAINT "place_reports_review_id_place_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."place_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_logo_media_id_place_media_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."place_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_cover_media_id_place_media_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."place_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "place_reports_open_subject_key" ON "place_reports" USING btree ("place_id","reporter_oxy_user_id",coalesce("media_id", ''),coalesce("review_id", '')) WHERE "place_reports"."resolved_at" is null;--> statement-breakpoint
ALTER TABLE "place_reports" ADD CONSTRAINT "place_reports_subject_check" CHECK ("place_reports"."media_id" is null or "place_reports"."review_id" is null);--> statement-breakpoint
ALTER TABLE "place_reports" ADD CONSTRAINT "place_reports_reason_check" CHECK ("place_reports"."reason" in ('does_not_exist', 'permanently_closed', 'wrong_location', 'wrong_details', 'duplicate', 'spam', 'offensive', 'privacy', 'not_this_place', 'conflict_of_interest'));--> statement-breakpoint
ALTER TABLE "place_revisions" ADD CONSTRAINT "place_revisions_action_check" CHECK ("place_revisions"."action" in ('place_created', 'place_updated', 'capability_asserted', 'capability_withdrawn', 'claim_requested', 'claim_approved', 'claim_rejected', 'claim_revoked', 'place_merged', 'place_absorbed', 'duplicate_rejected', 'report_resolved', 'hours_exception_created', 'hours_exception_replaced', 'hours_exception_withdrawn', 'media_added', 'media_removed', 'media_reordered', 'media_hidden', 'media_restored', 'review_published', 'review_updated', 'review_withdrawn', 'review_replied', 'review_reply_withdrawn', 'review_hidden', 'review_restored'));--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_description_check" CHECK ("places"."description" is null or (btrim("places"."description") <> '' and char_length("places"."description") <= 2000));