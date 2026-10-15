-- oxy:deploy-phase=pre
CREATE TABLE "organization_list_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"place_id" text NOT NULL,
	"activity" text NOT NULL,
	"information" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"position" integer NOT NULL,
	"updated_by_oxy_user_id" text NOT NULL,
	CONSTRAINT "organization_list_entries_schedule_check" CHECK ("organization_list_entries"."ends_at" > "organization_list_entries"."starts_at"),
	CONSTRAINT "organization_list_entries_position_check" CHECK ("organization_list_entries"."position" >= 0),
	CONSTRAINT "organization_list_entries_activity_check" CHECK (length(btrim("organization_list_entries"."activity")) between 1 and 160)
);
--> statement-breakpoint
CREATE TABLE "organization_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_account_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_lists_title_check" CHECK (length(btrim("organization_lists"."title")) between 1 and 160),
	CONSTRAINT "organization_lists_revision_check" CHECK ("organization_lists"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "organization_list_entries" ADD CONSTRAINT "organization_list_entries_list_id_organization_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."organization_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_list_entries" ADD CONSTRAINT "organization_list_entries_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_list_entries_order_idx" ON "organization_list_entries" USING btree ("list_id","position","id");--> statement-breakpoint
CREATE INDEX "organization_lists_account_idx" ON "organization_lists" USING btree ("oxy_account_id","id");