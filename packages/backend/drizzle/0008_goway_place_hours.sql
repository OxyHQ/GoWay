-- oxy:deploy-phase=pre
CREATE TABLE "place_hours_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"closed" boolean NOT NULL,
	"intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"verification" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_hours_exceptions_range_key" UNIQUE("place_id","starts_on","ends_on","verification"),
	CONSTRAINT "place_hours_exceptions_verification_check" CHECK ("place_hours_exceptions"."verification" in ('community_reported', 'external_source', 'business_asserted', 'oxy_verified')),
	CONSTRAINT "place_hours_exceptions_range_check" CHECK ("place_hours_exceptions"."starts_on" <= "place_hours_exceptions"."ends_on"),
	CONSTRAINT "place_hours_exceptions_span_check" CHECK ("place_hours_exceptions"."ends_on" - "place_hours_exceptions"."starts_on" < 366),
	CONSTRAINT "place_hours_exceptions_intervals_check" CHECK (jsonb_typeof("place_hours_exceptions"."intervals") = 'array' and "place_hours_exceptions"."closed" = (jsonb_array_length("place_hours_exceptions"."intervals") = 0)),
	CONSTRAINT "place_hours_exceptions_source_not_blank_check" CHECK (btrim("place_hours_exceptions"."source") <> '')
);
--> statement-breakpoint
ALTER TABLE "place_revisions" DROP CONSTRAINT "place_revisions_action_check";--> statement-breakpoint
ALTER TABLE "places_capabilities" DROP CONSTRAINT "places_capabilities_value_type_check";--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "place_hours_exceptions" ADD CONSTRAINT "place_hours_exceptions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_hours_exceptions_place_ends_idx" ON "place_hours_exceptions" USING btree ("place_id","ends_on");--> statement-breakpoint
ALTER TABLE "place_revisions" ADD CONSTRAINT "place_revisions_action_check" CHECK ("place_revisions"."action" in ('place_created', 'place_updated', 'capability_asserted', 'capability_withdrawn', 'claim_requested', 'claim_approved', 'claim_rejected', 'claim_revoked', 'place_merged', 'place_absorbed', 'duplicate_rejected', 'report_resolved', 'hours_exception_created', 'hours_exception_replaced', 'hours_exception_withdrawn'));--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_timezone_check" CHECK ("places"."timezone" is null or "places"."timezone" ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$');--> statement-breakpoint
ALTER TABLE "places_capabilities" ADD CONSTRAINT "places_capabilities_value_type_check" CHECK (jsonb_typeof("places_capabilities"."value") in ('boolean', 'string', 'number', 'array'));