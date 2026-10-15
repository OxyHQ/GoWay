package org.openmaptiles.addons;

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.FeatureMerge;
import com.onthegomap.planetiler.ForwardingProfile;
import com.onthegomap.planetiler.VectorTile;
import com.onthegomap.planetiler.config.PlanetilerConfig;
import com.onthegomap.planetiler.geo.GeometryException;
import com.onthegomap.planetiler.reader.SourceFeature;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.openmaptiles.Layer;
import org.openmaptiles.OpenMapTilesProfile;
import org.openmaptiles.util.OmtLanguageUtils;

/**
 * GoWay's {@code outdoors} layer: what a hiking and ski map needs that the OpenMapTiles schema does not carry. An
 * ADDON in the profile's own extension point ({@code ExtraLayers}), so every OpenMapTiles layer is exactly what it was
 * — this adds one layer and touches none.
 *
 * <p>
 * One source-layer, {@code outdoors}, keyed by {@code class}:
 * <ul>
 * <li>{@code trail} — a path, footway, track, bridleway or steps way that carries hiking difficulty or visibility:
 * {@code sac_scale} (OSM's SAC hiking scale, its six values), {@code trail_visibility} (its six values),
 * {@code subclass} (the {@code highway} value). z12+.</li>
 * <li>{@code via_ferrata} — {@code highway=via_ferrata}, with {@code via_ferrata_scale} (0–6). z12+.</li>
 * <li>{@code piste} — any way or area with {@code piste:type}: {@code piste_type}, {@code piste_difficulty},
 * {@code piste_grooming}. Lines z11+ (downhill) / z12+; areas as polygons z12+.</li>
 * <li>{@code climbing} — a crag, climbing area or boulder ({@code climbing=*}, or {@code sport=climbing} outdoors):
 * {@code climbing} (its kind), {@code routes}, {@code grade_min}/{@code grade_max} and {@code grade_system}. Points,
 * z11+ (boulders z13+).</li>
 * </ul>
 * Every feature carries {@code name} and {@code name:latin} when OSM names it. Unknown values are dropped, never
 * passed through: the vocabulary is the contract the style reads ({@code lib/map/style/schema.ts}).
 *
 * <p>
 * Aerial lifts are NOT here: OpenMapTiles' {@code transportation} layer already carries them ({@code class=aerialway},
 * the lift type as {@code subclass}).
 */
public class Outdoors implements
  Layer,
  OpenMapTilesProfile.OsmAllProcessor,
  OpenMapTilesProfile.IgnoreWikidata,
  ForwardingProfile.LayerPostProcessor {

  public static final String LAYER_NAME = "outdoors";

  /** OSM's {@code sac_scale}, easiest first (SAC T1–T6). */
  public static final List<String> SAC_SCALES = List.of(
    "hiking", "mountain_hiking", "demanding_mountain_hiking", "alpine_hiking", "demanding_alpine_hiking",
    "difficult_alpine_hiking");

  /** OSM's {@code trail_visibility}, best first. */
  public static final List<String> TRAIL_VISIBILITIES = List.of(
    "excellent", "good", "intermediate", "bad", "horrible", "no");

  public static final Set<String> TRAIL_HIGHWAYS = Set.of("path", "footway", "track", "bridleway", "steps");

  public static final Set<String> PISTE_TYPES = Set.of(
    "downhill", "nordic", "skitour", "sled", "hike", "sleigh", "snow_park", "connection", "ice_skate", "ski_jump",
    "playground", "fatbike");

  /** OSM's {@code piste:difficulty}, easiest first. */
  public static final List<String> PISTE_DIFFICULTIES = List.of(
    "novice", "easy", "intermediate", "advanced", "expert", "freeride", "extreme");

  public static final Set<String> PISTE_GROOMINGS = Set.of(
    "classic", "skating", "classic+skating", "classic;skating", "mogul", "backcountry", "scooter");

  public static final Set<String> CLIMBING_KINDS = Set.of("area", "crag", "boulder");

  /** Grade tags, in the order a grade is taken from: the systems Alpine and European climbing uses first. */
  private static final List<String> GRADE_SYSTEMS = List.of("french", "uiaa", "saxon", "yds_class", "british_adjectival");

  private final PlanetilerConfig config;

  public Outdoors(PlanetilerConfig config) {
    this.config = config;
  }

  @Override
  public String name() {
    return LAYER_NAME;
  }

  private static String lower(Object value) {
    return value == null ? null : value.toString().trim().toLowerCase(Locale.ROOT);
  }

  /** Membership that is false for a missing value: an immutable collection THROWS on {@code contains(null)}. */
  private static boolean in(java.util.Collection<String> values, String value) {
    return value != null && values.contains(value);
  }

  private static Integer integer(Object value) {
    if (value == null) return null;
    try {
      return Integer.parseInt(value.toString().trim().replaceAll("^[kK]", ""));
    } catch (NumberFormatException e) {
      return null;
    }
  }

  /** {@code name} and {@code name:latin} only: what GoWay's labels read. */
  private static Map<String, Object> names(SourceFeature feature, String... alsoFrom) {
    Map<String, Object> tags = new HashMap<>(feature.tags());
    if (tags.get("name") == null) {
      for (String key : alsoFrom) {
        if (tags.get(key) != null) {
          tags.put("name", tags.get(key));
          break;
        }
      }
    }
    Map<String, Object> all = OmtLanguageUtils.getNamesWithoutTranslations(tags);
    Map<String, Object> kept = new HashMap<>();
    if (all.get("name") != null) kept.put("name", all.get("name"));
    if (all.get("name:latin") != null) kept.put("name:latin", all.get("name:latin"));
    return kept;
  }

  @Override
  public void processAllOsm(SourceFeature feature, FeatureCollector features) {
    String highway = lower(feature.getTag("highway"));
    String pisteType = lower(feature.getTag("piste:type"));

    if (feature.canBeLine()) {
      // Via ferratas: their own class, whatever else the way says.
      if ("via_ferrata".equals(highway)) {
        Integer scale = integer(feature.getTag("via_ferrata_scale"));
        features.line(LAYER_NAME)
          .setAttr("class", "via_ferrata")
          .setAttr("via_ferrata_scale", scale != null && scale >= 0 && scale <= 6 ? scale : null)
          .putAttrs(names(feature))
          .setMinZoom(12)
          .setMinPixelSize(0)
          .setBufferPixels(4);
      } else if (in(TRAIL_HIGHWAYS, highway)) {
        String sac = lower(feature.getTag("sac_scale"));
        String visibility = lower(feature.getTag("trail_visibility"));
        sac = in(SAC_SCALES, sac) ? sac : null;
        visibility = in(TRAIL_VISIBILITIES, visibility) ? visibility : null;
        if (sac != null || visibility != null) {
          features.line(LAYER_NAME)
            .setAttr("class", "trail")
            .setAttr("subclass", highway)
            .setAttr("sac_scale", sac)
            .setAttr("trail_visibility", visibility)
            .putAttrs(names(feature))
            // The harder grades sort last, so they draw over an easier trail they share a way with.
            .setSortKey(sac == null ? 0 : SAC_SCALES.indexOf(sac) + 1)
            .setMinZoom(12)
            .setMinPixelSize(0)
            .setBufferPixels(4);
        }
      }
    }

    // Pistes: ski runs and nordic trails as lines, ski areas drawn as runs (area=yes) as polygons.
    if (in(PISTE_TYPES, pisteType)) {
      String difficulty = lower(feature.getTag("piste:difficulty"));
      difficulty = in(PISTE_DIFFICULTIES, difficulty) ? difficulty : null;
      String grooming = lower(feature.getTag("piste:grooming"));
      grooming = in(PISTE_GROOMINGS, grooming) ? grooming : null;
      boolean area = feature.canBePolygon() && ("yes".equals(lower(feature.getTag("area"))) ||
        feature.hasTag("landuse", "winter_sports"));
      var piste = area ? features.polygon(LAYER_NAME) : feature.canBeLine() ? features.line(LAYER_NAME) : null;
      if (piste != null) {
        piste
          .setAttr("class", "piste")
          .setAttr("piste_type", pisteType)
          .setAttr("piste_difficulty", difficulty)
          .setAttr("piste_grooming", grooming)
          .putAttrs(names(feature, "piste:name"))
          .setSortKey(difficulty == null ? 0 : PISTE_DIFFICULTIES.indexOf(difficulty) + 1)
          .setMinZoom(!area && "downhill".equals(pisteType) ? 11 : 12)
          .setMinPixelSize(area ? 2 : 0)
          .setBufferPixels(4);
      }
    }

    // Climbing: crags, areas and boulders, where people climb outside.
    String climbing = lower(feature.getTag("climbing"));
    boolean sportClimbing = feature.hasTag("sport", "climbing") &&
      !feature.hasTag("indoor", "yes") && !feature.hasTag("leisure", "sports_centre", "fitness_centre");
    if (in(CLIMBING_KINDS, climbing) || (climbing == null && sportClimbing)) {
      String kind = climbing != null ? climbing : "crag";
      String system = null;
      Object min = null;
      Object max = null;
      for (String candidate : GRADE_SYSTEMS) {
        Object lo = feature.getTag("climbing:grade:" + candidate + ":min");
        Object hi = feature.getTag("climbing:grade:" + candidate + ":max");
        if (lo != null || hi != null) {
          system = candidate;
          min = lo;
          max = hi;
          break;
        }
      }
      Integer routes = integer(feature.getTag("climbing:routes"));
      var point = feature.isPoint() ? features.point(LAYER_NAME) :
        feature.canBePolygon() ? features.pointOnSurface(LAYER_NAME) : null;
      if (point != null) {
        point
          .setAttr("class", "climbing")
          .setAttr("climbing", kind)
          .setAttr("routes", routes != null && routes > 0 ? routes : null)
          .setAttr("grade_system", system)
          .setAttr("grade_min", min == null ? null : min.toString())
          .setAttr("grade_max", max == null ? null : max.toString())
          .putAttrs(names(feature))
          .setMinZoom("boulder".equals(kind) ? 13 : 11)
          .setBufferPixels(32);
      }
    }
  }

  @Override
  public List<VectorTile.Feature> postProcess(int zoom, List<VectorTile.Feature> items) throws GeometryException {
    // Below the highest zoom, ways that share every attribute join into one line, as OpenMapTiles' own transportation
    // layer does: fewer, longer features and a smaller tile. At z14 they stay one per way.
    if (zoom >= config.maxzoom()) return items;
    return FeatureMerge.mergeLineStrings(items, 0.5, config.tolerance(zoom), 4);
  }
}
