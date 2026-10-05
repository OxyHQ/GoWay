-- oxy:deploy-phase=pre
CREATE TABLE "place_categories" (
	"key" text PRIMARY KEY NOT NULL,
	"parent_key" text,
	"icon" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_categories_key_check" CHECK ("place_categories"."key" ~ '^[a-z0-9_]+([.][a-z0-9_]+)*$' and char_length("place_categories"."key") <= 64),
	CONSTRAINT "place_categories_parent_check" CHECK ("place_categories"."parent_key" is not distinct from nullif(regexp_replace("place_categories"."key", '[.]?[^.]+$', ''), '')),
	CONSTRAINT "place_categories_icon_check" CHECK ("place_categories"."icon" in ('place', 'restaurant', 'cafe', 'bar', 'nightlife', 'bakery', 'grocery', 'shop', 'clothing', 'book', 'gift', 'beauty', 'electronics', 'hardware', 'laundry', 'pet', 'hotel', 'camping', 'park', 'nature', 'water', 'entertainment', 'sport', 'golf', 'museum', 'art', 'theatre', 'cinema', 'music', 'landmark', 'information', 'bus', 'train', 'subway', 'ferry', 'bike', 'car', 'fuel', 'parking', 'charging', 'hospital', 'health', 'pharmacy', 'school', 'civic', 'police', 'mail', 'toilets', 'bank', 'worship', 'office', 'tools')),
	CONSTRAINT "place_categories_status_check" CHECK ("place_categories"."status" in ('active', 'deprecated')),
	CONSTRAINT "place_categories_position_check" CHECK ("place_categories"."position" between 0 and 1000000)
);
--> statement-breakpoint
CREATE TABLE "place_category_events" (
	"id" text PRIMARY KEY NOT NULL,
	"category_key" text NOT NULL,
	"action" text NOT NULL,
	"oxy_account_id" text NOT NULL,
	"operated_by_oxy_user_id" text,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_category_events_action_check" CHECK ("place_category_events"."action" in ('created', 'updated', 'label_set', 'label_removed')),
	CONSTRAINT "place_category_events_changes_array_check" CHECK (jsonb_typeof("place_category_events"."changes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "place_category_labels" (
	"category_key" text NOT NULL,
	"language" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_category_labels_pkey" PRIMARY KEY("category_key","language"),
	CONSTRAINT "place_category_labels_language_check" CHECK ("place_category_labels"."language" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$'),
	CONSTRAINT "place_category_labels_label_check" CHECK ("place_category_labels"."label" <> '' and "place_category_labels"."label" = btrim("place_category_labels"."label") and "place_category_labels"."label" is nfc normalized and char_length("place_category_labels"."label") <= 80)
);
--> statement-breakpoint
CREATE TABLE "place_category_osm_tags" (
	"tag" text PRIMARY KEY NOT NULL,
	"category_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "place_category_osm_tags_tag_check" CHECK ("place_category_osm_tags"."tag" ~ '^[a-z][a-z0-9_:]*=(\*|[a-z0-9][a-z0-9_:.-]*)$')
);
--> statement-breakpoint
ALTER TABLE "place_categories" ADD CONSTRAINT "place_categories_parent_fk" FOREIGN KEY ("parent_key") REFERENCES "public"."place_categories"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_category_events" ADD CONSTRAINT "place_category_events_category_key_place_categories_key_fk" FOREIGN KEY ("category_key") REFERENCES "public"."place_categories"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_category_labels" ADD CONSTRAINT "place_category_labels_category_key_place_categories_key_fk" FOREIGN KEY ("category_key") REFERENCES "public"."place_categories"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_category_osm_tags" ADD CONSTRAINT "place_category_osm_tags_category_key_place_categories_key_fk" FOREIGN KEY ("category_key") REFERENCES "public"."place_categories"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_categories_parent_idx" ON "place_categories" USING btree ("parent_key");--> statement-breakpoint
CREATE INDEX "place_category_events_category_created_idx" ON "place_category_events" USING btree ("category_key","created_at","id");--> statement-breakpoint
CREATE INDEX "place_category_osm_tags_category_idx" ON "place_category_osm_tags" USING btree ("category_key");