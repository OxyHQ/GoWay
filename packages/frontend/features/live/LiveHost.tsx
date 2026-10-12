/**
 * GoWay Live on the explore map: the socket, the store, the layer the canvas
 * draws, and the panel — everything the feature is, behind ONE lazy import.
 *
 * `ExploreScreen` loads this with `React.lazy` only when
 * the map-feature registry says `live` is on, and hands the
 * resulting {@link MapLiveLayer} to `MapCanvas` through `onLayer`. With the
 * flag off this module, `socket.io-client` and the SDK's live protocol are
 * never requested.
 *
 * The layer works signed out — browsing is public — and sends nothing about
 * the viewer: see `liveClient.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoWayUnavailableError } from '@goway.to/sdk';
import type { LiveKind } from '@goway.to/sdk/live';

import type { MapCreditLink, MapLiveLayer, MapLivePoint } from '@/components/map';
import { API_URL } from '@/lib/config';

import { watchLiveAvailability } from './availability';
import { FLEETS } from './fleets';
import { LIVE_GLYPHS, LIVE_KIND_ORDER } from './kinds';
import {
  BIKESHARE_MIN_ZOOM,
  createLiveClient,
  type LiveClient,
  type LiveClientState,
} from './liveClient';
import { LivePanel } from './LivePanel';
import { LiveStore } from './liveStore';
import { pointOf } from './points';
import { coverageKindOf, coverageOf } from './coverageOf';
import { clearLiveCoverage, type LiveCoverageKind, publishLiveCoverage } from '@/lib/live/coverage';
import { ShapeCache } from './shapeCache';

type Box = { west: number; south: number; east: number; north: number };

/** A box grown by `fraction` of its size on every side; `null` (draw everything) across the antimeridian. */
function padded(box: Box, fraction: number): Box | null {
  if (box.west > box.east || box.east - box.west >= 360) return null;
  const dx = (box.east - box.west) * fraction;
  const dy = (box.north - box.south) * fraction;
  return { west: box.west - dx, east: box.east + dx, south: box.south - dy, north: box.north + dy };
}

function inView(box: Box, point: { latitude: number; longitude: number }): boolean {
  return (
    point.latitude >= box.south &&
    point.latitude <= box.north &&
    point.longitude >= box.west &&
    point.longitude <= box.east
  );
}

export interface LiveHostProps {
  onLayer: (layer: MapLiveLayer | null) => void;
}

/** How often freshness text and fading are re-evaluated with nothing else happening. */
const HEARTBEAT_MS = 1000;

function meetsView(
  coverage: { west: number; south: number; east: number; north: number } | null,
  view: { west: number; south: number; east: number; north: number } | null,
): boolean {
  if (!coverage || !view) return true;
  return (
    coverage.west <= view.east &&
    coverage.east >= view.west &&
    coverage.south <= view.north &&
    coverage.north >= view.south
  );
}

/** Lines are fetched from this zoom: below it a train is a few pixels and its curve invisible. */
const SHAPES_MIN_ZOOM = 12;

/** Rendered in the map's top-right stack (`ExploreScreen`), which places it. */
export default function LiveHost({ onLayer }: LiveHostProps) {
  const listeners = useRef(new Set<() => void>());
  // A shape arriving moves its vehicles onto the track: wake the canvas.
  const store = useMemo(
    () =>
      new LiveStore(
        Date.now,
        new ShapeCache(() => {
          for (const listener of listeners.current) listener();
        }),
      ),
    [],
  );
  const [kinds, setKinds] = useState<ReadonlySet<LiveKind>>(() => new Set(LIVE_KIND_ORDER));
  const [selected, setSelected] = useState<string | null>(null);
  const [clientState, setClientState] = useState<LiveClientState>({
    connection: 'connecting',
    coverage: 'waiting',
  });
  const [, setHeartbeat] = useState(0);

  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const clientRef = useRef<LiveClient | null>(null);
  const creditsRef = useRef<readonly MapCreditLink[]>([]);
  const drawnSourcesRef = useRef<ReadonlySet<string>>(new Set());
  const movingRef = useRef(false);
  const zoomRef = useRef(0);
  /** The kinds of vehicle each source has been seen sending (for the coverage channel). */
  const modesRef = useRef(new Map<string, Set<LiveCoverageKind>>());
  /** The visible box, padded: only what is near the screen is sampled and drawn. */
  const viewRef = useRef<{ west: number; south: number; east: number; north: number } | null>(null);

  const notify = useCallback(() => {
    for (const listener of listeners.current) listener();
  }, []);

  /** Credits for the sources whose data was drawn in the last sample, deduplicated. */
  const refreshCredits = useCallback(() => {
    const seen = new Set<string>();
    const credits: MapCreditLink[] = [];
    for (const source of store.sources()) {
      if (!drawnSourcesRef.current.has(source.id)) continue;
      const label = `${source.attribution.label} (${source.licence.label})`;
      // One line per credit: the MTA's bus and rail feeds credit the MTA once.
      if (seen.has(source.attribution.label)) continue;
      seen.add(source.attribution.label);
      credits.push({ label, href: source.attribution.href });
    }
    const previous = creditsRef.current;
    const changed =
      previous.length !== credits.length ||
      previous.some((credit, index) => credit.label !== credits[index]?.label);
    if (changed) creditsRef.current = credits;
    return changed;
  }, [store]);

  const layer = useMemo<MapLiveLayer>(
    () => ({
      glyphs: LIVE_GLYPHS,
      models: FLEETS,
      sample(now: number): MapLivePoint[] {
        const zoom = zoomRef.current;
        const drawn = new Set<string>();
        let moving = false;
        const points: MapLivePoint[] = [];
        const view = viewRef.current;
        for (const sample of store.sample(kindsRef.current, now)) {
          const entity = sample.entity;
          // A room is ~300 km across; the screen is a corner of it.
          if (view && !inView(view, sample)) continue;
          // A city has thousands of docks: stations appear where a street does.
          if (entity.kind === 'bikeshare' && zoom < BIKESHARE_MIN_ZOOM) continue;
          drawn.add(entity.sourceId);
          if (entity.kind === 'transit') {
            const kind = coverageKindOf(entity.mode);
            if (kind) {
              const modes = modesRef.current.get(entity.sourceId) ?? new Set<LiveCoverageKind>();
              modes.add(kind);
              modesRef.current.set(entity.sourceId, modes);
            }
          }
          if (sample.moving) moving = true;
          points.push(pointOf(sample, selectedRef.current));
        }
        movingRef.current = moving;
        drawnSourcesRef.current = drawn;
        return points;
      },
      animating: () => movingRef.current,
      subscribe(listener) {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      setViewport(view) {
        zoomRef.current = view.zoom;
        viewRef.current = padded(view.bounds, 0.25);
        store.setShapeArea(view.zoom >= SHAPES_MIN_ZOOM ? viewRef.current : null);
        clientRef.current?.setView(view);
      },
      select(id) {
        // The ring moves on the next frame, before React re-renders the card.
        selectedRef.current = id;
        setSelected(id);
        for (const listener of listeners.current) listener();
      },
      credits: () => creditsRef.current,
    }),
    [store],
  );

  // Whether this backend serves live at all: a deployment without it
  // (no `LIVE_SOURCES`) answers 503 and the layer stays out of sight — the
  // switch can be on by default before the backend is.
  const [available, setAvailable] = useState(false);
  useEffect(
    () =>
      watchLiveAvailability({
        check: () =>
          import('@/lib/live/client')
            .then(({ liveApiClient }) => liveApiClient.live.sources())
            .then(
              () => 'yes' as const,
              // Anything but "no live here" (offline, a blip) is the socket's
              // to report and retry.
              (error: unknown) => (error instanceof GoWayUnavailableError ? 'no' : 'yes'),
            ),
        onAvailable: () => setAvailable(true),
      }),
    [],
  );

  // The connection: opened once per mount, closed on unmount.
  useEffect(() => {
    if (!available) return;
    const client = createLiveClient({ apiUrl: API_URL, store });
    clientRef.current = client;
    client.setKinds([...kindsRef.current]);
    const unsubscribe = client.subscribe(() => {
      setClientState(client.state());
      notify();
    });
    onLayer(layer);
    return () => {
      unsubscribe();
      client.close();
      clientRef.current = null;
      onLayer(null);
    };
  }, [available, store, layer, onLayer, notify]);

  useEffect(() => {
    clientRef.current?.setKinds(LIVE_KIND_ORDER.filter((kind) => kinds.has(kind)));
    notify();
  }, [kinds, notify]);

  // Freshness ticks on with no data arriving: ages grow, things go stale.
  useEffect(() => {
    const timer = setInterval(() => {
      setHeartbeat((beat) => beat + 1);
      refreshCredits();
      // Tell other features where real transit is drawn (`lib/live/coverage.ts`).
      publishLiveCoverage(
        coverageOf(
          kindsRef.current.has('transit') ? store.sources() : [],
          modesRef.current,
          viewRef.current,
        ),
      );
      notify();
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      clearLiveCoverage();
    };
  }, [notify, refreshCredits, store]);

  const toggleKind = useCallback((kind: LiveKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const selectedSample = selected ? store.sampleOne(selected) : null;
  // A selection that expired or was filtered away closes its card.
  useEffect(() => {
    if (selected && (!selectedSample || !kinds.has(selectedSample.entity.kind))) setSelected(null);
  }, [selected, selectedSample, kinds]);

  if (!available) return null;
  return (
    <LivePanel
      // On by default for everyone: it starts as the pill, opened on demand.
      initiallyExpanded={false}
      kinds={kinds}
      onToggleKind={toggleKind}
      state={clientState}
      // Only the feeds whose coverage meets the map: Barcelona does not list New York's.
      sources={store.sources().filter((source) => meetsView(source.coverage, viewRef.current))}
      serverNow={store.serverNow()}
      selected={selectedSample}
      selectedSource={selectedSample ? store.source(selectedSample.entity.sourceId) : undefined}
      onCloseSelected={() => setSelected(null)}
    />
  );
}
