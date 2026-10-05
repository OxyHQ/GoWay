-- oxy:deploy-phase=post
-- Custom SQL migration: the place data the new image reads, converted in place.
-- POST, because each step narrows what the previous image wrote: categories
-- become taxonomy keys, a source's statement becomes `{v: 2, tags, normalized}`,
-- and the timezone leaves the schedule for its own column.
--
-- THIS FILE IS ALSO A PROGRAM. `bun run places:convert-legacy`
-- (src/places/legacyConversion.ts) reads it, runs every statement that is not
-- an UPDATE once per session, and runs each UPDATE below in id-ordered batches
-- by adding an id range to its WHERE clause. That is how ~13M production rows
-- are converted BEFORE this migration runs, so that here every UPDATE matches
-- only the stragglers written since. So:
--
--  - every UPDATE must stay idempotent: its WHERE matches only a row it would
--    change, and it is a no-op on a row it already converted;
--  - every UPDATE ends with ONE top-level `WHERE` at the start of a line, the
--    last line-initial `WHERE` in the statement, which the converter wraps in
--    parentheses and narrows to a range of "id";
--  - `src/places/__tests__/legacyConversion.realdb.test.ts` proves that the
--    converter followed by this migration leaves byte-identical rows to this
--    migration alone, and that this migration then rewrites no row at all.
--
-- It runs BEFORE `0012` and `0013`: those take ACCESS EXCLUSIVE locks that
-- the migrator's single transaction holds until it commits, so anything slow
-- must come first.

-- 1. A legacy category list as taxonomy keys.
--
-- Every legacy key is mapped (the OpenStreetMap value, the OpenMapTiles class
-- and the group the old importer wrote, the free-text keys the app used, and
-- every taxonomy key to itself so a re-run is a no-op); unmapped keys are
-- dropped; repeats collapse in first-seen order; and a key that is an ANCESTOR
-- of another kept key is dropped, because a parent filter already matches its
-- descendants. The same function converts `places.categories` and the
-- importer's recorded `categories`, so a column that equalled what
-- OpenStreetMap last said still equals it afterwards and the next import
-- refreshes it with the new mapping.
--
-- The mapping is a session table rather than a VALUES list inside the
-- function: an indexed lookup instead of hashing 389 rows on every call, which
-- halves the cost of a function that runs once per place.
CREATE TEMP TABLE "goway_category_mapping" (
  "legacy_key" text PRIMARY KEY,
  "category_key" text NOT NULL
);
--> statement-breakpoint
INSERT INTO pg_temp."goway_category_mapping" ("legacy_key", "category_key") VALUES
  ('aerialway', 'transport.aerialway'),
  ('alcohol', 'shop.alcohol'),
  ('alcohol_shop', 'shop.alcohol'),
  ('alpine_hut', 'lodging.hut'),
  ('amusement_arcade', 'leisure.amusement'),
  ('antiques', 'shop.second_hand'),
  ('apartment', 'lodging.apartment'),
  ('aquarium', 'culture.aquarium'),
  ('archaeological_site', 'culture.archaeological_site'),
  ('art', 'shop.art'),
  ('art_gallery', 'culture.gallery'),
  ('arts_centre', 'culture.gallery'),
  ('artwork', 'culture.artwork'),
  ('atm', 'finance.atm'),
  ('attraction', 'culture.attraction'),
  ('bag', 'shop.clothes'),
  ('bakery', 'food.bakery'),
  ('bank', 'finance.bank'),
  ('bar', 'food.bar'),
  ('barber', 'shop.hairdresser'),
  ('basin', 'leisure.water'),
  ('beach_resort', 'leisure.beach'),
  ('beauty', 'shop.beauty'),
  ('bed', 'shop.furniture'),
  ('bed_and_breakfast', 'lodging.guest_house'),
  ('beer', 'food.pub'),
  ('beverages', 'shop.alcohol'),
  ('bicycle', 'shop.bicycle'),
  ('bicycle_rental', 'transport.bicycle_rental'),
  ('biergarten', 'food.pub'),
  ('books', 'shop.books'),
  ('bookshop', 'shop.books'),
  ('boutique', 'shop.clothes'),
  ('bowling_alley', 'leisure.amusement'),
  ('brewery', 'craft.brewery'),
  ('bureau_de_change', 'finance.exchange'),
  ('bus', 'transport.bus_stop'),
  ('bus_station', 'transport.bus_station'),
  ('bus_stop', 'transport.bus_stop'),
  ('butcher', 'shop.butcher'),
  ('cafe', 'food.cafe'),
  ('camera', 'shop.electronics'),
  ('camp_site', 'lodging.camping'),
  ('campsite', 'lodging.camping'),
  ('car', 'vehicle.dealer'),
  ('car_parts', 'vehicle.repair'),
  ('car_rental', 'transport.car_rental'),
  ('car_repair', 'vehicle.repair'),
  ('car_sharing', 'transport.car_rental'),
  ('car_wash', 'vehicle.car_wash'),
  ('caravan_site', 'lodging.camping'),
  ('carpet', 'shop.furniture'),
  ('castle', 'culture.castle'),
  ('cemetery', 'civic.cemetery'),
  ('chalet', 'lodging.apartment'),
  ('charging_station', 'vehicle.charging'),
  ('charity', 'shop.second_hand'),
  ('cheese', 'shop.deli'),
  ('chemist', 'shop.chemist'),
  ('childcare', 'education.kindergarten'),
  ('chocolate', 'food.confectionery'),
  ('cinema', 'culture.cinema'),
  ('civic', 'civic'),
  ('civic.cemetery', 'civic.cemetery'),
  ('civic.community_centre', 'civic.community_centre'),
  ('civic.courthouse', 'civic.courthouse'),
  ('civic.embassy', 'civic.embassy'),
  ('civic.fire_station', 'civic.fire_station'),
  ('civic.police', 'civic.police'),
  ('civic.post_box', 'civic.post_box'),
  ('civic.post_office', 'civic.post_office'),
  ('civic.toilets', 'civic.toilets'),
  ('civic.townhall', 'civic.townhall'),
  ('climbing', 'sport.climbing'),
  ('clinic', 'health.clinic'),
  ('clothes', 'shop.clothes'),
  ('clothing_store', 'shop.clothes'),
  ('coffee', 'food.cafe'),
  ('college', 'education.university'),
  ('community_centre', 'civic.community_centre'),
  ('company', 'office.company'),
  ('computer', 'shop.electronics'),
  ('concert_hall', 'culture.music_venue'),
  ('confectionery', 'food.confectionery'),
  ('convenience', 'shop.convenience'),
  ('copyshop', 'shop.stationery'),
  ('cosmetics', 'shop.beauty'),
  ('courthouse', 'civic.courthouse'),
  ('coworking', 'office.coworking'),
  ('coworking_space', 'office.coworking'),
  ('craft', 'craft'),
  ('craft.brewery', 'craft.brewery'),
  ('craft.winery', 'craft.winery'),
  ('culture', 'culture'),
  ('culture.aquarium', 'culture.aquarium'),
  ('culture.archaeological_site', 'culture.archaeological_site'),
  ('culture.artwork', 'culture.artwork'),
  ('culture.attraction', 'culture.attraction'),
  ('culture.castle', 'culture.castle'),
  ('culture.cinema', 'culture.cinema'),
  ('culture.gallery', 'culture.gallery'),
  ('culture.historic', 'culture.historic'),
  ('culture.information', 'culture.information'),
  ('culture.monument', 'culture.monument'),
  ('culture.museum', 'culture.museum'),
  ('culture.music_venue', 'culture.music_venue'),
  ('culture.theatre', 'culture.theatre'),
  ('culture.viewpoint', 'culture.viewpoint'),
  ('culture.zoo', 'culture.zoo'),
  ('curtain', 'shop.furniture'),
  ('deli', 'shop.deli'),
  ('delicatessen', 'shop.deli'),
  ('dentist', 'health.dentist'),
  ('department_store', 'shop.department_store'),
  ('diplomatic', 'civic.embassy'),
  ('distillery', 'craft.brewery'),
  ('dock', 'leisure.marina'),
  ('doctors', 'health.doctor'),
  ('dog_park', 'leisure.dog_park'),
  ('doityourself', 'shop.hardware'),
  ('dormitory', 'lodging.hostel'),
  ('driving_school', 'education.training'),
  ('dry_cleaning', 'shop.laundry'),
  ('e-cigarette', 'shop.tobacco'),
  ('education', 'education'),
  ('education.kindergarten', 'education.kindergarten'),
  ('education.library', 'education.library'),
  ('education.school', 'education.school'),
  ('education.training', 'education.training'),
  ('education.university', 'education.university'),
  ('electronics', 'shop.electronics'),
  ('embassy', 'civic.embassy'),
  ('equestrian', 'sport.horse_riding'),
  ('escape_game', 'leisure.amusement'),
  ('estate_agent', 'office.estate_agent'),
  ('fashion_accessories', 'shop.clothes'),
  ('fast_food', 'food.fast_food'),
  ('ferry_terminal', 'transport.ferry_terminal'),
  ('finance', 'finance'),
  ('finance.atm', 'finance.atm'),
  ('finance.bank', 'finance.bank'),
  ('finance.exchange', 'finance.exchange'),
  ('fire_station', 'civic.fire_station'),
  ('fitness_centre', 'leisure.fitness'),
  ('fitness_station', 'leisure.fitness'),
  ('florist', 'shop.florist'),
  ('food', 'food'),
  ('food_court', 'food.fast_food'),
  ('food_drink', 'food'),
  ('food.bakery', 'food.bakery'),
  ('food.bar', 'food.bar'),
  ('food.cafe', 'food.cafe'),
  ('food.confectionery', 'food.confectionery'),
  ('food.fast_food', 'food.fast_food'),
  ('food.ice_cream', 'food.ice_cream'),
  ('food.nightclub', 'food.nightclub'),
  ('food.pub', 'food.pub'),
  ('food.restaurant', 'food.restaurant'),
  ('fort', 'culture.castle'),
  ('frame', 'shop.art'),
  ('fuel', 'vehicle.fuel'),
  ('furniture', 'shop.furniture'),
  ('gallery', 'culture.gallery'),
  ('garden', 'leisure.garden'),
  ('garden_centre', 'shop.florist'),
  ('gift', 'shop.gift'),
  ('golf', 'sport.golf'),
  ('golf_course', 'sport.golf'),
  ('government', 'office.government'),
  ('grave_yard', 'civic.cemetery'),
  ('greengrocer', 'shop.greengrocer'),
  ('grocery', 'shop.supermarket'),
  ('guest_house', 'lodging.guest_house'),
  ('hackerspace', 'civic.community_centre'),
  ('hairdresser', 'shop.hairdresser'),
  ('halt', 'transport.rail_station'),
  ('harbor', 'leisure.marina'),
  ('hardware', 'shop.hardware'),
  ('health', 'health'),
  ('health.care_home', 'health.care_home'),
  ('health.clinic', 'health.clinic'),
  ('health.dentist', 'health.dentist'),
  ('health.doctor', 'health.doctor'),
  ('health.hospital', 'health.hospital'),
  ('health.pharmacy', 'health.pharmacy'),
  ('health.veterinary', 'health.veterinary'),
  ('hearing_aids', 'shop.optician'),
  ('hifi', 'shop.electronics'),
  ('horse_riding', 'sport.horse_riding'),
  ('hospital', 'health.hospital'),
  ('hostel', 'lodging.hostel'),
  ('hotel', 'lodging.hotel'),
  ('houseware', 'shop.furniture'),
  ('ice_cream', 'food.ice_cream'),
  ('ice_rink', 'sport.ice_rink'),
  ('information', 'culture.information'),
  ('insurance', 'office.insurance'),
  ('interior_decoration', 'shop.furniture'),
  ('jewelry', 'shop.jewelry'),
  ('kindergarten', 'education.kindergarten'),
  ('kiosk', 'shop.newsagent'),
  ('lamps', 'shop.furniture'),
  ('language_school', 'education.training'),
  ('laundry', 'shop.laundry'),
  ('lawyer', 'office.lawyer'),
  ('leisure', 'leisure'),
  ('leisure.amusement', 'leisure.amusement'),
  ('leisure.beach', 'leisure.beach'),
  ('leisure.dog_park', 'leisure.dog_park'),
  ('leisure.fitness', 'leisure.fitness'),
  ('leisure.garden', 'leisure.garden'),
  ('leisure.marina', 'leisure.marina'),
  ('leisure.nature_reserve', 'leisure.nature_reserve'),
  ('leisure.park', 'leisure.park'),
  ('leisure.picnic_site', 'leisure.picnic_site'),
  ('leisure.playground', 'leisure.playground'),
  ('leisure.water', 'leisure.water'),
  ('library', 'education.library'),
  ('lodging', 'lodging'),
  ('lodging.apartment', 'lodging.apartment'),
  ('lodging.camping', 'lodging.camping'),
  ('lodging.guest_house', 'lodging.guest_house'),
  ('lodging.hostel', 'lodging.hostel'),
  ('lodging.hotel', 'lodging.hotel'),
  ('lodging.hut', 'lodging.hut'),
  ('mall', 'shop.department_store'),
  ('marina', 'leisure.marina'),
  ('marketplace', 'shop.marketplace'),
  ('memorial', 'culture.monument'),
  ('miniature_golf', 'sport.golf'),
  ('mobile_phone', 'shop.electronics'),
  ('monastery', 'worship'),
  ('monument', 'culture.monument'),
  ('motel', 'lodging.hotel'),
  ('motorcycle', 'vehicle.motorcycle'),
  ('museum', 'culture.museum'),
  ('music', 'shop.music'),
  ('music_school', 'education.training'),
  ('music_venue', 'culture.music_venue'),
  ('musical_instrument', 'shop.music'),
  ('nature_reserve', 'leisure.nature_reserve'),
  ('newsagent', 'shop.newsagent'),
  ('nightclub', 'food.nightclub'),
  ('notary', 'office.lawyer'),
  ('nursing_home', 'health.care_home'),
  ('office', 'office'),
  ('office.company', 'office.company'),
  ('office.coworking', 'office.coworking'),
  ('office.estate_agent', 'office.estate_agent'),
  ('office.government', 'office.government'),
  ('office.insurance', 'office.insurance'),
  ('office.lawyer', 'office.lawyer'),
  ('optician', 'shop.optician'),
  ('outdoor', 'shop.sports'),
  ('outdoors', 'leisure'),
  ('paint', 'shop.hardware'),
  ('parcel_locker', 'civic.post_box'),
  ('park', 'leisure.park'),
  ('parking', 'vehicle.parking'),
  ('parking_entrance', 'vehicle.parking'),
  ('pastry', 'food.bakery'),
  ('perfume', 'shop.beauty'),
  ('perfumery', 'shop.beauty'),
  ('pet', 'shop.pet'),
  ('pharmacy', 'health.pharmacy'),
  ('picnic_site', 'leisure.picnic_site'),
  ('pitch', 'sport.pitch'),
  ('place_of_worship', 'worship'),
  ('playground', 'leisure.playground'),
  ('police', 'civic.police'),
  ('post', 'civic.post_office'),
  ('post_box', 'civic.post_box'),
  ('post_office', 'civic.post_office'),
  ('pub', 'food.pub'),
  ('railway', 'transport.rail_station'),
  ('reservoir', 'leisure.water'),
  ('restaurant', 'food.restaurant'),
  ('ruins', 'culture.castle'),
  ('school', 'education.school'),
  ('seafood', 'shop.butcher'),
  ('second_hand', 'shop.second_hand'),
  ('services', 'services'),
  ('shoes', 'shop.shoes'),
  ('shop', 'shop'),
  ('shop.alcohol', 'shop.alcohol'),
  ('shop.art', 'shop.art'),
  ('shop.beauty', 'shop.beauty'),
  ('shop.bicycle', 'shop.bicycle'),
  ('shop.books', 'shop.books'),
  ('shop.butcher', 'shop.butcher'),
  ('shop.chemist', 'shop.chemist'),
  ('shop.clothes', 'shop.clothes'),
  ('shop.convenience', 'shop.convenience'),
  ('shop.deli', 'shop.deli'),
  ('shop.department_store', 'shop.department_store'),
  ('shop.electronics', 'shop.electronics'),
  ('shop.florist', 'shop.florist'),
  ('shop.furniture', 'shop.furniture'),
  ('shop.gift', 'shop.gift'),
  ('shop.greengrocer', 'shop.greengrocer'),
  ('shop.hairdresser', 'shop.hairdresser'),
  ('shop.hardware', 'shop.hardware'),
  ('shop.jewelry', 'shop.jewelry'),
  ('shop.laundry', 'shop.laundry'),
  ('shop.marketplace', 'shop.marketplace'),
  ('shop.music', 'shop.music'),
  ('shop.newsagent', 'shop.newsagent'),
  ('shop.optician', 'shop.optician'),
  ('shop.pet', 'shop.pet'),
  ('shop.second_hand', 'shop.second_hand'),
  ('shop.shoes', 'shop.shoes'),
  ('shop.sports', 'shop.sports'),
  ('shop.stationery', 'shop.stationery'),
  ('shop.supermarket', 'shop.supermarket'),
  ('shop.tobacco', 'shop.tobacco'),
  ('shop.toys', 'shop.toys'),
  ('shop.travel_agency', 'shop.travel_agency'),
  ('shopping', 'shop'),
  ('skiing', 'sport.skiing'),
  ('social_centre', 'civic.community_centre'),
  ('social_facility', 'health.care_home'),
  ('souvenir', 'shop.gift'),
  ('sport', 'sport'),
  ('sport.centre', 'sport.centre'),
  ('sport.climbing', 'sport.climbing'),
  ('sport.golf', 'sport.golf'),
  ('sport.horse_riding', 'sport.horse_riding'),
  ('sport.ice_rink', 'sport.ice_rink'),
  ('sport.pitch', 'sport.pitch'),
  ('sport.skiing', 'sport.skiing'),
  ('sport.stadium', 'sport.stadium'),
  ('sport.swimming', 'sport.swimming'),
  ('sports', 'shop.sports'),
  ('sports_centre', 'sport.centre'),
  ('sports_hall', 'sport.centre'),
  ('stadium', 'sport.stadium'),
  ('station', 'transport.rail_station'),
  ('stationery', 'shop.stationery'),
  ('supermarket', 'shop.supermarket'),
  ('swimming', 'sport.swimming'),
  ('swimming_area', 'leisure.beach'),
  ('swimming_pool', 'sport.swimming'),
  ('taxi', 'transport.taxi'),
  ('tea', 'food.cafe'),
  ('theatre', 'culture.theatre'),
  ('theme_park', 'leisure.amusement'),
  ('tobacco', 'shop.tobacco'),
  ('toilets', 'civic.toilets'),
  ('town_hall', 'civic.townhall'),
  ('townhall', 'civic.townhall'),
  ('toys', 'shop.toys'),
  ('track', 'sport.pitch'),
  ('tram_stop', 'transport.tram_stop'),
  ('transit', 'transport'),
  ('transit_station', 'transport.rail_station'),
  ('transport', 'transport'),
  ('transport.aerialway', 'transport.aerialway'),
  ('transport.bicycle_rental', 'transport.bicycle_rental'),
  ('transport.bus_station', 'transport.bus_station'),
  ('transport.bus_stop', 'transport.bus_stop'),
  ('transport.car_rental', 'transport.car_rental'),
  ('transport.ferry_terminal', 'transport.ferry_terminal'),
  ('transport.rail_station', 'transport.rail_station'),
  ('transport.taxi', 'transport.taxi'),
  ('transport.tram_stop', 'transport.tram_stop'),
  ('travel_agency', 'shop.travel_agency'),
  ('tyres', 'vehicle.repair'),
  ('university', 'education.university'),
  ('variety_store', 'shop.department_store'),
  ('vehicle', 'vehicle'),
  ('vehicle.car_wash', 'vehicle.car_wash'),
  ('vehicle.charging', 'vehicle.charging'),
  ('vehicle.dealer', 'vehicle.dealer'),
  ('vehicle.fuel', 'vehicle.fuel'),
  ('vehicle.motorcycle', 'vehicle.motorcycle'),
  ('vehicle.parking', 'vehicle.parking'),
  ('vehicle.repair', 'vehicle.repair'),
  ('veterinary', 'health.veterinary'),
  ('video_games', 'shop.electronics'),
  ('viewpoint', 'culture.viewpoint'),
  ('watches', 'shop.jewelry'),
  ('water_park', 'leisure.amusement'),
  ('wholesale', 'shop.supermarket'),
  ('wilderness_hut', 'lodging.hut'),
  ('wine', 'shop.alcohol'),
  ('winery', 'craft.winery'),
  ('winter_sports', 'sport.skiing'),
  ('worship', 'worship'),
  ('zoo', 'culture.zoo');
--> statement-breakpoint
ANALYZE pg_temp."goway_category_mapping";
--> statement-breakpoint
CREATE FUNCTION pg_temp.goway_category_keys(legacy text[]) RETURNS text[] LANGUAGE sql STABLE AS $$
  WITH mapped AS (
    SELECT mapping.category_key, min(given.position) AS position
    FROM unnest(legacy) WITH ORDINALITY AS given(legacy_key, position)
    JOIN pg_temp.goway_category_mapping AS mapping ON mapping.legacy_key = given.legacy_key
    GROUP BY mapping.category_key
  )
  SELECT coalesce(array_agg(mapped.category_key ORDER BY mapped.position), '{}'::text[])
  FROM mapped
  WHERE NOT EXISTS (
    SELECT 1 FROM mapped AS other WHERE other.category_key LIKE mapped.category_key || '.%'
  )
$$;
--> statement-breakpoint
-- 2. A source's statement, versioned. A version-1 row was the normalized facts
-- alone; it becomes `normalized`, with its categories converted by the same
-- function, beside an empty `tags` that the next import fills.
CREATE FUNCTION pg_temp.goway_source_data_v2(legacy_data jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'v', 2,
    'tags', '{}'::jsonb,
    'normalized', CASE
      WHEN jsonb_typeof(legacy_data -> 'categories') = 'array' THEN jsonb_set(
        legacy_data,
        '{categories}',
        to_jsonb(pg_temp.goway_category_keys(ARRAY(SELECT jsonb_array_elements_text(legacy_data -> 'categories'))))
      )
      ELSE legacy_data
    END
  )
$$;
--> statement-breakpoint
-- A list that is already converted is its own conversion: every key a
-- taxonomy key (each maps to itself), none repeated, none an ancestor of
-- another — the same LIKE the function uses. Answering that without calling
-- the function is what makes this statement cheap on a table that is already
-- converted, where it is a scan rather than ~13M function calls. An empty list
-- converts to itself too. CASE fixes the order, so the function runs only for
-- the rows that need it.
UPDATE "places"
SET "categories" = pg_temp.goway_category_keys("categories")
WHERE CASE
  WHEN cardinality("categories") = 0 THEN false
  WHEN "categories" <@ (SELECT array_agg("category_key") FROM pg_temp."goway_category_mapping" WHERE "category_key" = "legacy_key")
    AND NOT EXISTS (
      SELECT 1
      FROM unnest("categories") WITH ORDINALITY AS "one"("key", "at"),
        unnest("categories") WITH ORDINALITY AS "other"("key", "at")
      WHERE "one"."at" <> "other"."at" AND ("other"."key" = "one"."key" OR "other"."key" LIKE "one"."key" || '.%')
    )
    THEN false
  ELSE "categories" IS DISTINCT FROM pg_temp.goway_category_keys("categories")
END;
--> statement-breakpoint
UPDATE "places_sources"
SET "source_data" = pg_temp.goway_source_data_v2("source_data")
WHERE "source_data" IS NOT NULL AND "source_data" -> 'v' IS NULL;
--> statement-breakpoint
-- 3. The timezone moves out of the schedule. A zone a writer put there seeds
-- the column when it is spelled like one; the next write that sets a position
-- derives it from that position instead.
UPDATE "places"
SET
  "timezone" = coalesce(
    "timezone",
    CASE WHEN "opening_hours" ->> 'timezone' ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$' THEN "opening_hours" ->> 'timezone' END
  ),
  "opening_hours" = "opening_hours" - 'timezone'
WHERE "opening_hours" -> 'timezone' IS NOT NULL;
