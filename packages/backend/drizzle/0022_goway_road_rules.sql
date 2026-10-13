-- oxy:deploy-phase=pre
CREATE TABLE "road_countries" (
	"country_code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"geometry" jsonb NOT NULL,
	"west" double precision NOT NULL,
	"south" double precision NOT NULL,
	"east" double precision NOT NULL,
	"north" double precision NOT NULL,
	"source" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "road_countries_country_check" CHECK ("road_countries"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "road_countries_name_check" CHECK (btrim("road_countries"."name") <> ''),
	CONSTRAINT "road_countries_status_check" CHECK ("road_countries"."status" in ('active', 'withdrawn')),
	CONSTRAINT "road_countries_geometry_check" CHECK ("road_countries"."geometry" ->> 'type' in ('Polygon', 'MultiPolygon'))
);
--> statement-breakpoint
CREATE TABLE "road_rule_events" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" text NOT NULL,
	"sync_id" text NOT NULL,
	"previous" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "road_rule_events_subject_check" CHECK ("road_rule_events"."subject" in ('rule_set', 'zone', 'country')),
	CONSTRAINT "road_rule_events_action_check" CHECK ("road_rule_events"."action" in ('created', 'updated', 'withdrawn', 'restored'))
);
--> statement-breakpoint
CREATE TABLE "road_rule_sets" (
	"country_code" text PRIMARY KEY NOT NULL,
	"driving_side" text NOT NULL,
	"speed_limits_kmh" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "road_rule_sets_country_check" CHECK ("road_rule_sets"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "road_rule_sets_driving_side_check" CHECK ("road_rule_sets"."driving_side" in ('left', 'right')),
	CONSTRAINT "road_rule_sets_status_check" CHECK ("road_rule_sets"."status" in ('active', 'withdrawn')),
	CONSTRAINT "road_rule_sets_speed_limits_check" CHECK (jsonb_typeof("road_rule_sets"."speed_limits_kmh") = 'object')
);
--> statement-breakpoint
CREATE TABLE "road_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"country_code" text NOT NULL,
	"geometry" jsonb NOT NULL,
	"west" double precision NOT NULL,
	"south" double precision NOT NULL,
	"east" double precision NOT NULL,
	"north" double precision NOT NULL,
	"timezone" text NOT NULL,
	"schedule" jsonb,
	"effective_from" text,
	"effective_until" text,
	"policy" jsonb NOT NULL,
	"rules_url" text,
	"source" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "road_zones_id_check" CHECK ("road_zones"."id" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
	CONSTRAINT "road_zones_country_check" CHECK ("road_zones"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "road_zones_name_check" CHECK (btrim("road_zones"."name") <> ''),
	CONSTRAINT "road_zones_kind_check" CHECK ("road_zones"."kind" in ('low_emission', 'congestion_charge', 'restricted_access')),
	CONSTRAINT "road_zones_status_check" CHECK ("road_zones"."status" in ('active', 'withdrawn')),
	CONSTRAINT "road_zones_geometry_check" CHECK ("road_zones"."geometry" ->> 'type' in ('Polygon', 'MultiPolygon')),
	CONSTRAINT "road_zones_bounds_check" CHECK ("road_zones"."south" between -90 and 90 and "road_zones"."north" between -90 and 90 and "road_zones"."south" <= "road_zones"."north" and "road_zones"."west" between -180 and 180 and "road_zones"."east" between -180 and 180),
	CONSTRAINT "road_zones_dates_check" CHECK (("road_zones"."effective_from" is null or "road_zones"."effective_from" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and ("road_zones"."effective_until" is null or "road_zones"."effective_until" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
);
--> statement-breakpoint
CREATE INDEX "road_rule_events_subject_idx" ON "road_rule_events" USING btree ("subject","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "road_zones_country_idx" ON "road_zones" USING btree ("country_code","id");--> statement-breakpoint
CREATE INDEX "road_zones_bounds_idx" ON "road_zones" USING btree ("south","north");