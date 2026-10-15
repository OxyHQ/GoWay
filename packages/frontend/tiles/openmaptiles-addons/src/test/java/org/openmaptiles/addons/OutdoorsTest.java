package org.openmaptiles.addons;

import static com.onthegomap.planetiler.TestUtils.newLineString;
import static com.onthegomap.planetiler.TestUtils.newPoint;
import static com.onthegomap.planetiler.TestUtils.rectangle;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.TestUtils;
import com.onthegomap.planetiler.config.PlanetilerConfig;
import com.onthegomap.planetiler.reader.SimpleFeature;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.stats.Stats;
import com.onthegomap.planetiler.util.Translations;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.Test;
import org.locationtech.jts.geom.Geometry;
import org.openmaptiles.OpenMapTilesProfile;

/**
 * GoWay's {@code outdoors} addon, through the WHOLE OpenMapTiles profile — so it is also a test that the addon is
 * registered and that the OpenMapTiles layers beside it are unchanged.
 */
class OutdoorsTest {

  private final PlanetilerConfig config = PlanetilerConfig.defaults();
  private final OpenMapTilesProfile profile =
    new OpenMapTilesProfile(Translations.nullProvider(List.of()), config, Stats.inMemory());
  private final FeatureCollector.Factory factory = new FeatureCollector.Factory(config, Stats.inMemory());

  private List<FeatureCollector.Feature> process(Geometry geometry, Map<String, Object> tags) {
    SourceFeature feature =
      SimpleFeature.create(geometry, new HashMap<>(tags), OpenMapTilesProfile.OSM_SOURCE, null, 0);
    var collector = factory.get(feature);
    profile.processFeature(feature, collector);
    return StreamSupport.stream(collector.spliterator(), false).toList();
  }

  private List<Map<String, Object>> outdoors(List<FeatureCollector.Feature> features, int zoom) {
    return features.stream()
      .filter(f -> f.getLayer().equals(Outdoors.LAYER_NAME))
      .map(f -> TestUtils.toMap(f, zoom))
      .toList();
  }

  private static Geometry line() {
    return newLineString(0, 0, 1, 1);
  }

  @Test
  void aHikingTrailCarriesItsSacScaleVisibilityAndName() {
    var features = process(line(), Map.of(
      "highway", "path", "sac_scale", "demanding_mountain_hiking", "trail_visibility", "bad", "name", "Grand Balcon"));
    var trail = outdoors(features, 14);
    assertEquals(1, trail.size());
    assertEquals("trail", trail.get(0).get("class"));
    assertEquals("path", trail.get(0).get("subclass"));
    assertEquals("demanding_mountain_hiking", trail.get(0).get("sac_scale"));
    assertEquals("bad", trail.get(0).get("trail_visibility"));
    assertEquals("Grand Balcon", trail.get(0).get("name"));
    assertEquals(12, trail.get(0).get("_minzoom"));
    // OpenMapTiles' own path is still there, untouched.
    assertTrue(features.stream().anyMatch(f -> f.getLayer().equals("transportation")));
  }

  @Test
  void aPathWithNoDifficultyOrVisibilityIsNotDuplicated() {
    assertEquals(List.of(), outdoors(process(line(), Map.of("highway", "path")), 14));
    assertEquals(List.of(), outdoors(process(line(), Map.of("highway", "residential", "sac_scale", "hiking")), 14));
  }

  @Test
  void unknownValuesAreDroppedNotPassedThrough() {
    var trail = outdoors(process(line(), Map.of(
      "highway", "footway", "sac_scale", "T3", "trail_visibility", "excellent")), 14);
    assertEquals(1, trail.size());
    assertNull(trail.get(0).get("sac_scale"));
    assertEquals("excellent", trail.get(0).get("trail_visibility"));
  }

  @Test
  void aViaFerrataCarriesItsScale() {
    var ferrata = outdoors(process(line(), Map.of(
      "highway", "via_ferrata", "via_ferrata_scale", "4", "name", "Via ferrata des Evettes")), 14);
    assertEquals(1, ferrata.size());
    assertEquals("via_ferrata", ferrata.get(0).get("class"));
    assertEquals(4, ferrata.get(0).get("via_ferrata_scale"));
    var outOfRange = outdoors(process(line(), Map.of("highway", "via_ferrata", "via_ferrata_scale", "9")), 14);
    assertNull(outOfRange.get(0).get("via_ferrata_scale"));
  }

  @Test
  void aPisteCarriesItsTypeDifficultyAndGrooming() {
    var run = outdoors(process(line(), Map.of(
      "piste:type", "downhill", "piste:difficulty", "advanced", "piste:grooming", "mogul", "piste:name", "La Verte")),
      14);
    assertEquals(1, run.size());
    assertEquals("piste", run.get(0).get("class"));
    assertEquals("downhill", run.get(0).get("piste_type"));
    assertEquals("advanced", run.get(0).get("piste_difficulty"));
    assertEquals("mogul", run.get(0).get("piste_grooming"));
    assertEquals("La Verte", run.get(0).get("name"));
    assertEquals(11, run.get(0).get("_minzoom"));

    var nordic = outdoors(process(line(), Map.of("piste:type", "nordic", "piste:grooming", "classic+skating")), 14);
    assertEquals(12, nordic.get(0).get("_minzoom"));
    assertEquals("classic+skating", nordic.get(0).get("piste_grooming"));
  }

  @Test
  void aPisteAreaIsAPolygon() {
    var area = outdoors(process(rectangle(0, 1), Map.of(
      "piste:type", "downhill", "piste:difficulty", "easy", "area", "yes")), 14);
    assertEquals(1, area.size());
    assertEquals("polygon", area.get(0).get("_type"));
  }

  @Test
  void aCragCarriesItsKindRoutesAndGrades() {
    var crag = outdoors(process(newPoint(0, 0), Map.of(
      "climbing", "crag", "climbing:routes", "42", "climbing:grade:french:min", "5a",
      "climbing:grade:french:max", "7b+", "name", "Les Gaillands")), 14);
    assertEquals(1, crag.size());
    assertEquals("climbing", crag.get(0).get("class"));
    assertEquals("crag", crag.get(0).get("climbing"));
    assertEquals(42, crag.get(0).get("routes"));
    assertEquals("french", crag.get(0).get("grade_system"));
    assertEquals("5a", crag.get(0).get("grade_min"));
    assertEquals("7b+", crag.get(0).get("grade_max"));
    assertEquals(11, crag.get(0).get("_minzoom"));
  }

  @Test
  void anIndoorClimbingGymIsNotACrag() {
    assertEquals(List.of(),
      outdoors(process(newPoint(0, 0), Map.of("sport", "climbing", "leisure", "sports_centre")), 14));
    assertEquals(1, outdoors(process(newPoint(0, 0), Map.of("sport", "climbing", "natural", "cliff")), 14).size());
  }
}
