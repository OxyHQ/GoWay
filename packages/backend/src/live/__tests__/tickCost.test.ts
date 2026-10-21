/**
 * A tick's cost does not grow with watched rooms × sources: which sources a
 * room is demand for is worked out once, when its first watcher joins
 * (`indexRoom`), not every tick for every source (634–797 ms a tick at 2,000
 * sockets before).
 */
import { describe, expect, it } from 'bun:test';
import { liveTileOf } from '@goway/contracts';
import { parseLiveConfig } from '../../config/live';
import { LIVE_SOURCE_IDS } from '../catalogue';
import { LiveHub, MAX_POLLS_PER_HOST } from '../hub';
import { configuredLiveSources } from '../index';

describe('the hub at 2,000 sockets', () => {
  it('ticks in milliseconds, and still wants exactly the sources watched', async () => {
    const quiet = { info: () => {}, warn: () => {} };
    const sources = configuredLiveSources(
      parseLiveConfig({ LIVE_SOURCES: 'all' }, LIVE_SOURCE_IDS),
      quiet,
    ).map(({ definition, settings }) => ({
      definition: {
        ...definition,
        staticGtfs: undefined,
        create: () => ({ poll: async () => ({ entities: [], rejected: 0 }) }),
      },
      settings,
    }));
    const hub = new LiveHub({
      sources,
      fetch: async () => {
        throw new Error('nothing is fetched');
      },
      publish: () => {},
    });
    // 2,000 viewers over the world's cities, 20 street rooms each.
    let seed = 1;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    for (let viewer = 0; viewer < 2000; viewer++) {
      const latitude = -45 + random() * 110;
      const longitude = -180 + random() * 360;
      const rooms = Array.from({ length: 20 }, (_, i) => ({
        tile: liveTileOf(
          { latitude: latitude + (i % 5) * 0.1, longitude: longitude + Math.floor(i / 5) * 0.1 },
          'transit',
        ),
        kind: 'transit' as const,
      }));
      hub.watch(`viewer-${viewer}`, rooms);
    }
    hub.watch('madrid', [
      { tile: liveTileOf({ latitude: 40.42, longitude: -3.7 }, 'transit'), kind: 'transit' },
    ]);
    await hub.tick();
    const started = performance.now();
    for (let i = 0; i < 5; i++) await hub.tick();
    const perTick = (performance.now() - started) / 5;
    expect(perTick).toBeLessThan(60);
    // Madrid's buses are wanted; a source nobody near watches is idle.
    const status = Object.fromEntries(hub.sources().map((source) => [source.id, source.status]));
    expect(status['aisa-bus']).not.toBe('idle');
    hub.stop();
  });
});

describe('one upstream host', () => {
  it(`is polled by at most ${MAX_POLLS_PER_HOST} sources at once; the rest wait their turn`, async () => {
    const japan = configuredLiveSources(parseLiveConfig({ LIVE_SOURCES: 'all' }, LIVE_SOURCE_IDS), {
      info: () => {},
      warn: () => {},
    }).filter(({ definition }) => definition.id.startsWith('japan-'));
    expect(japan.length).toBeGreaterThan(5);
    const release: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const polled = new Set<string>();
    const hub = new LiveHub({
      sources: japan.map(({ definition, settings }) => ({
        definition: {
          ...definition,
          staticGtfs: undefined,
          create: () => ({
            poll: () =>
              new Promise((resolve) => {
                inFlight++;
                most = Math.max(most, inFlight);
                polled.add(definition.id);
                release.push(() => {
                  inFlight--;
                  resolve({ entities: [], rejected: 0 });
                });
              }),
          }),
        },
        settings,
      })),
      fetch: async () => {
        throw new Error('nothing is fetched');
      },
      publish: () => {},
    });
    // A viewer everywhere in Japan the feeds cover.
    const rooms = japan.map(({ definition }) => {
      const box = definition.coverage ?? { west: 139, south: 35, east: 140, north: 36 };
      return {
        tile: liveTileOf(
          { latitude: (box.south + box.north) / 2, longitude: (box.west + box.east) / 2 },
          'transit',
        ),
        kind: 'transit' as const,
      };
    });
    hub.watch('viewer', rooms);
    for (let round = 0; round < japan.length; round++) {
      void hub.tick();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(most).toBeLessThanOrEqual(MAX_POLLS_PER_HOST);
      for (const done of release.splice(0)) done();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polled.size).toBe(japan.length);
    hub.stop();
  });
});
