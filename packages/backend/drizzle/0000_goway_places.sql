-- oxy:deploy-phase=pre
--
-- GoWay Places: the canonical GoWay-owned identity and enrichment layer.
--
-- `pre`, and it is genuinely additive: five new tables, their constraints and
-- their indexes. Nothing is dropped, renamed or narrowed, so this is correct
-- against the image still serving AND the one arriving, and it must be applied
-- BEFORE the rollout — the new image's Places routes cannot answer a single
-- request without these tables.
--
-- POSTGIS IS A PRECONDITION OF THIS FILE, NOT PART OF IT. The `places.geo`
-- column below names the `geography` type, so on a database without the
-- extension the very first statement fails with
-- `type "geography" does not exist`. `src/db/extensions.ts` declares it and
-- `bun run db:migrate` ensures it before any DDL runs; `CREATE EXTENSION` is
-- privileged, so a NEWLY provisioned database needs a superuser to run it once
-- by hand first. See that module for the full explanation.
--
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"geo" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"geometry" jsonb,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"address_house_number" text,
	"address_street" text,
	"address_locality" text,
	"address_city" text,
	"address_region" text,
	"address_postal_code" text,
	"address_country_code" text,
	"address_country" text,
	"address_formatted" text,
	"contact_phone" text,
	"contact_email" text,
	"contact_website" text,
	"opening_hours" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"verification_state" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_status_check" CHECK ("places"."status" in ('active', 'closed', 'proposed', 'removed')),
	CONSTRAINT "places_verification_state_check" CHECK ("places"."verification_state" in ('unverified', 'community_reviewed', 'oxy_verified', 'owner_verified')),
	CONSTRAINT "places_latitude_range_check" CHECK ("places"."latitude" between -90 and 90),
	CONSTRAINT "places_longitude_range_check" CHECK ("places"."longitude" between -180 and 180),
	CONSTRAINT "places_name_not_blank_check" CHECK (btrim("places"."name") <> ''),
	CONSTRAINT "places_country_code_check" CHECK ("places"."address_country_code" is null or "places"."address_country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "places_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"namespace" text NOT NULL,
	"capability" text NOT NULL,
	"key" text GENERATED ALWAYS AS (namespace || '.' || capability) STORED,
	"value" jsonb NOT NULL,
	"verification" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"place_source_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_capabilities_assertion_key" UNIQUE("place_id","namespace","capability","verification"),
	CONSTRAINT "places_capabilities_verification_check" CHECK ("places_capabilities"."verification" in ('community_reported', 'external_source', 'business_asserted', 'oxy_verified')),
	CONSTRAINT "places_capabilities_namespace_shape_check" CHECK ("places_capabilities"."namespace" ~ '^[a-z0-9_-]+([.][a-z0-9_-]+)*$'),
	CONSTRAINT "places_capabilities_capability_shape_check" CHECK ("places_capabilities"."capability" ~ '^[a-z0-9_-]+$'),
	CONSTRAINT "places_capabilities_value_type_check" CHECK (jsonb_typeof("places_capabilities"."value") in ('boolean', 'string', 'number')),
	CONSTRAINT "places_capabilities_external_source_check" CHECK ("places_capabilities"."verification" <> 'external_source' or "places_capabilities"."place_source_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "places_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"oxy_account_id" text NOT NULL,
	"brand_id" text,
	"role" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_claims_account_role_key" UNIQUE("place_id","oxy_account_id","role"),
	CONSTRAINT "places_claims_role_check" CHECK ("places_claims"."role" in ('owner', 'operator', 'manager', 'brand')),
	CONSTRAINT "places_claims_state_check" CHECK ("places_claims"."state" in ('pending', 'approved', 'rejected', 'revoked')),
	CONSTRAINT "places_claims_decided_at_check" CHECK (("places_claims"."state" = 'pending') = ("places_claims"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "places_duplicate_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"candidate_place_id" text NOT NULL,
	"reason" text NOT NULL,
	"score" double precision,
	"state" text DEFAULT 'open' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_duplicates_pair_key" UNIQUE("place_id","candidate_place_id"),
	CONSTRAINT "places_duplicates_reason_check" CHECK ("places_duplicate_candidates"."reason" in ('shared_source_id', 'proximity_and_name', 'manual_report')),
	CONSTRAINT "places_duplicates_state_check" CHECK ("places_duplicate_candidates"."state" in ('open', 'confirmed', 'rejected')),
	CONSTRAINT "places_duplicates_pair_order_check" CHECK ("places_duplicate_candidates"."place_id" < "places_duplicate_candidates"."candidate_place_id"),
	CONSTRAINT "places_duplicates_score_range_check" CHECK ("places_duplicate_candidates"."score" is null or "places_duplicate_candidates"."score" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "places_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_data" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_sources_source_record_key" UNIQUE("source","source_id"),
	CONSTRAINT "places_sources_source_not_blank_check" CHECK (btrim("places_sources"."source") <> ''),
	CONSTRAINT "places_sources_source_id_not_blank_check" CHECK (btrim("places_sources"."source_id") <> '')
);
--> statement-breakpoint
ALTER TABLE "places_capabilities" ADD CONSTRAINT "places_capabilities_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places_capabilities" ADD CONSTRAINT "places_capabilities_place_source_id_places_sources_id_fk" FOREIGN KEY ("place_source_id") REFERENCES "public"."places_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places_claims" ADD CONSTRAINT "places_claims_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places_duplicate_candidates" ADD CONSTRAINT "places_duplicate_candidates_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places_duplicate_candidates" ADD CONSTRAINT "places_duplicate_candidates_candidate_place_id_places_id_fk" FOREIGN KEY ("candidate_place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places_sources" ADD CONSTRAINT "places_sources_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "places_geo_gist" ON "places" USING gist ("geo");--> statement-breakpoint
CREATE INDEX "places_categories_gin" ON "places" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "places_status_idx" ON "places" USING btree ("status");--> statement-breakpoint
CREATE INDEX "places_name_normalized_idx" ON "places" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "places_capabilities_key_idx" ON "places_capabilities" USING btree ("key");--> statement-breakpoint
CREATE INDEX "places_capabilities_place_idx" ON "places_capabilities" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "places_claims_place_state_idx" ON "places_claims" USING btree ("place_id","state");--> statement-breakpoint
CREATE INDEX "places_claims_account_idx" ON "places_claims" USING btree ("oxy_account_id");--> statement-breakpoint
CREATE INDEX "places_claims_brand_idx" ON "places_claims" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "places_duplicates_state_idx" ON "places_duplicate_candidates" USING btree ("state");--> statement-breakpoint
CREATE INDEX "places_duplicates_candidate_idx" ON "places_duplicate_candidates" USING btree ("candidate_place_id");--> statement-breakpoint
CREATE INDEX "places_sources_place_idx" ON "places_sources" USING btree ("place_id");