package org.openmaptiles.addons;

import com.onthegomap.planetiler.config.PlanetilerConfig;
import com.onthegomap.planetiler.stats.Stats;
import com.onthegomap.planetiler.util.Translations;
import java.util.List;
import org.openmaptiles.Layer;

/**
 * Registry of extra custom layers that you can add to the openmaptiles schema.
 *
 * <p>
 * GoWay's: replaces the profile's empty registry at build time ({@code scripts/build-planetiler.ts}). Every layer here
 * is ADDED beside the OpenMapTiles layers, never instead of one.
 */
public class ExtraLayers {

  public static List<Layer> create(Translations translations, PlanetilerConfig config, Stats stats) {
    return List.of(
      new Outdoors(config)
    );
  }
}
