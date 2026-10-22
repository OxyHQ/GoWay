-- oxy:deploy-phase=pre
CREATE TABLE "camera_observations" (
	"camera_id" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"counts" jsonb NOT NULL,
	"present" jsonb NOT NULL,
	"flow_per_minute" double precision,
	"congestion" text,
	"health" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "camera_observations_camera_id_window_to_pk" PRIMARY KEY("camera_id","window_to"),
	CONSTRAINT "camera_observations_window_check" CHECK ("camera_observations"."window_from" <= "camera_observations"."window_to"),
	CONSTRAINT "camera_observations_counts_check" CHECK (jsonb_typeof("camera_observations"."counts") = 'object' and jsonb_typeof("camera_observations"."present") = 'object'),
	CONSTRAINT "camera_observations_flow_check" CHECK ("camera_observations"."flow_per_minute" is null or "camera_observations"."flow_per_minute" >= 0),
	CONSTRAINT "camera_observations_congestion_check" CHECK ("camera_observations"."congestion" is null or "camera_observations"."congestion" in ('free', 'busy', 'slow', 'stopped')),
	CONSTRAINT "camera_observations_health_check" CHECK ("camera_observations"."health" in ('ok', 'dark', 'obstructed', 'frozen'))
);
--> statement-breakpoint
CREATE TABLE "cameras" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"geo" "geography" GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
	"heading" double precision,
	"road_name" text,
	"media_kind" text NOT NULL,
	"media_refresh_seconds" integer,
	"media_width" integer,
	"media_height" integer,
	"upstream_url" text NOT NULL,
	"last_frame_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cameras_id_check" CHECK ("cameras"."id" ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
	CONSTRAINT "cameras_provider_check" CHECK ("cameras"."provider_id" ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
	CONSTRAINT "cameras_name_check" CHECK (btrim("cameras"."name") <> ''),
	CONSTRAINT "cameras_kind_check" CHECK ("cameras"."kind" in ('traffic', 'city', 'harbour', 'mountain', 'weather')),
	CONSTRAINT "cameras_media_kind_check" CHECK ("cameras"."media_kind" in ('snapshot', 'mjpeg', 'hls')),
	CONSTRAINT "cameras_latitude_range_check" CHECK ("cameras"."latitude" between -90 and 90),
	CONSTRAINT "cameras_longitude_range_check" CHECK ("cameras"."longitude" between -180 and 180),
	CONSTRAINT "cameras_heading_check" CHECK ("cameras"."heading" is null or ("cameras"."heading" >= 0 and "cameras"."heading" < 360)),
	CONSTRAINT "cameras_snapshot_refresh_check" CHECK (("cameras"."media_kind" = 'snapshot') = ("cameras"."media_refresh_seconds" is not null)),
	CONSTRAINT "cameras_upstream_url_check" CHECK ("cameras"."upstream_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE INDEX "camera_observations_recent_idx" ON "camera_observations" USING btree ("camera_id","window_to" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "camera_observations_window_to_idx" ON "camera_observations" USING btree ("window_to");--> statement-breakpoint
CREATE UNIQUE INDEX "cameras_provider_source_uq" ON "cameras" USING btree ("provider_id","source_id");--> statement-breakpoint
CREATE INDEX "cameras_geo_gist" ON "cameras" USING gist ("geo");