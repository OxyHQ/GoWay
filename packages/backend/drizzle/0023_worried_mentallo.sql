-- oxy:deploy-phase=pre
CREATE TABLE "saved_place_list_items" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"place_id" text NOT NULL,
	"note" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "saved_place_list_items_position_check" CHECK ("saved_place_list_items"."position" >= 0),
	CONSTRAINT "saved_place_list_items_note_check" CHECK ("saved_place_list_items"."note" is null or (btrim("saved_place_list_items"."note") <> '' and char_length("saved_place_list_items"."note") <= 500))
);
--> statement-breakpoint
CREATE TABLE "saved_place_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
	"visibility" text DEFAULT 'private' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "saved_place_lists_visibility_check" CHECK ("saved_place_lists"."visibility" in ('private')),
	CONSTRAINT "saved_place_lists_name_check" CHECK (btrim("saved_place_lists"."name") <> '' and char_length("saved_place_lists"."name") <= 80)
);
--> statement-breakpoint
ALTER TABLE "saved_place_list_items" ADD CONSTRAINT "saved_place_list_items_list_id_saved_place_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."saved_place_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_place_list_items" ADD CONSTRAINT "saved_place_list_items_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_place_list_items_list_place_key" ON "saved_place_list_items" USING btree ("list_id","place_id");--> statement-breakpoint
CREATE INDEX "saved_place_list_items_list_position_idx" ON "saved_place_list_items" USING btree ("list_id","position","id");--> statement-breakpoint
CREATE INDEX "saved_place_list_items_place_idx" ON "saved_place_list_items" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_place_lists_owner_name_key" ON "saved_place_lists" USING btree ("owner_oxy_user_id","name_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_place_lists_owner_default_key" ON "saved_place_lists" USING btree ("owner_oxy_user_id") WHERE "saved_place_lists"."is_default";--> statement-breakpoint
CREATE INDEX "saved_place_lists_owner_created_idx" ON "saved_place_lists" USING btree ("owner_oxy_user_id","created_at","id");