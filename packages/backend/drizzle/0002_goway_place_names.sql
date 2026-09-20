-- oxy:deploy-phase=pre
--
-- GoWay place names, in every language a source records one in (issue #61).
--
-- `pre`, and genuinely so. One new table, its constraints, its indexes, and one
-- WIDENED CHECK. Nothing is dropped, renamed or narrowed, so this is correct
-- against the image still serving AND the one arriving, and it must be applied
-- BEFORE the rollout: the new image's Places reads join `places_names` on every
-- request that names a locale.
--
-- The `places_duplicates_reason_check` drop-and-add below is a WIDENING and not
-- an exception to the phase. The new set is a superset of the old one, so every
-- value the previous image can write is still accepted while it keeps serving;
-- `proximity_and_translated_name` is only ever written by the new image. Both
-- statements run in one transaction, so no concurrent writer sees the table
-- unconstrained.
--
-- WHY THIS TABLE EXISTS BEFORE THE IMPORT THAT FILLS IT. The OpenStreetMap POI
-- import writes millions of rows. `places.name` alone would have picked one
-- language for all of them permanently — OSM's bare `name`, which is the LOCAL
-- language and not English — and undoing that later means re-importing the
-- planet across a table that by then also holds GoWay edits, claims and
-- contributions a re-import must not clobber. The schema therefore changes
-- first and the importer is written against this shape.
--
-- The two constraints worth reading before changing anything here:
--
--   `places_names_language_source_key` — the grain is (place, language,
--   SOURCE), not (place, language). That third column is what makes a
--   GoWay-owned correction to the Spanish name survive the next OpenStreetMap
--   import: the importer's upsert targets the `openstreetmap` row and cannot
--   name the `goway` row, so "never destructively overwrite a source fact" is a
--   property of the key rather than of whoever writes the importer.
--
--   `places_names_language_tag_check` — the canonical BCP 47 subset, built from
--   the SAME pattern `@goway/shared-types` publishes and the HTTP layer
--   normalizes to. Its primary subtag is deliberately two or three letters:
--   the wider BCP 47 rule admits `left`, `right`, `signed` and `prefix`, all of
--   which are real OpenStreetMap `name:*` keys and none of which is a language.
--
-- PostGIS is a precondition of this file exactly as it is for `0000` and
-- `0001`: `places` is referenced here and names the `geography` type.
--
CREATE TABLE "places_names" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "places_names_language_source_key" UNIQUE("place_id","language","source"),
	CONSTRAINT "places_names_language_tag_check" CHECK ("places_names"."language" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$'),
	CONSTRAINT "places_names_name_not_blank_check" CHECK (btrim("places_names"."name") <> ''),
	CONSTRAINT "places_names_source_not_blank_check" CHECK (btrim("places_names"."source") <> '')
);
--> statement-breakpoint
ALTER TABLE "places_duplicate_candidates" DROP CONSTRAINT "places_duplicates_reason_check";--> statement-breakpoint
ALTER TABLE "places_names" ADD CONSTRAINT "places_names_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "places_names_place_idx" ON "places_names" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "places_names_name_normalized_idx" ON "places_names" USING btree ("name_normalized");--> statement-breakpoint
ALTER TABLE "places_duplicate_candidates" ADD CONSTRAINT "places_duplicates_reason_check" CHECK ("places_duplicate_candidates"."reason" in ('shared_source_id', 'proximity_and_name', 'proximity_and_translated_name', 'manual_report'));
