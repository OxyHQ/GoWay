/**
 * The provider-adapter seam for GoWay Live.
 *
 * A source is a {@link LiveSourceDefinition} — who runs the feed, under what
 * licence, where it has data, how often it may be asked — plus a factory for
 * the {@link LiveAdapter} that speaks its format. Everything above this seam
 * (`hub.ts`, the socket, the HTTP route) sees normalised `LiveEntity` values
 * from `@goway/contracts` and nothing of adsb.lol, GTFS-Realtime, GBFS or AIS.
 *
 * ## An adapter's whole job
 *
 * Fetch, then turn each upstream record into a contract value or REFUSE it.
 * A record with an impossible coordinate, a missing timestamp or a shape the
 * adapter does not recognise is counted in `rejected` and dropped — never
 * coerced into a plausible entity somewhere it is not. The result is checked
 * against `liveEntitySchema` before it leaves (`normalise.ts → accept`), so a
 * normaliser bug becomes a rejection count rather than a malformed message on
 * every viewer's socket.
 */

import type { GeoBoundingBox, LiveEntity, LiveKind, LiveTransitMode } from '@goway/contracts';
import type { HubProviderDefinition } from '../hub/provider';
import type { MatchHint, StaticGtfs, StaticGtfsLocation } from './staticGtfs';

/** What a poll may use. Injected, so every adapter is tested without a network. */
export interface LiveFetchContext {
  /** Aborted on timeout and on shutdown. */
  signal: AbortSignal;
  fetch: LiveFetch;
  /** Milliseconds since the epoch. */
  now: () => number;
  /**
   * The room tiles' boxes somebody is watching that intersect this source's
   * coverage. A regional source (aircraft) polls only these; a fixed-coverage
   * feed ignores them (it is one request whatever is watched).
   */
  demand: readonly GeoBoundingBox[];
  /** The source's static GTFS, once loaded (estimating adapters need its shapes and stops). */
  staticGtfs?: StaticGtfs | null;
}

/** The slice of `fetch` the adapters use. */
export type LiveFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface LivePollResult {
  entities: LiveEntity[];
  /** Upstream records refused as junk. */
  rejected: number;
  /**
   * The upstream asked us to slow down part-way (a 429 after some requests
   * had answered): wait at least this long before the next poll.
   */
  backoffSeconds?: number;
  /**
   * Per entity id, what the feed said that a static GTFS can join on (the
   * trip, the route). Internal: never re-served.
   */
  hints?: Map<string, MatchHint>;
}

export interface LiveAdapter {
  poll(context: LiveFetchContext): Promise<LivePollResult>;
}

/** Endpoint, key and identity, resolved from configuration. */
export interface LiveAdapterSettings {
  url: string;
  key?: string;
  userAgent: string;
  /** Regional sources: upstream requests per poll. */
  maxRegionsPerPoll: number;
}

export interface LiveSourceDefinition extends HubProviderDefinition {
  kind: LiveKind;
  /** `null` for worldwide. */
  coverage: GeoBoundingBox | null;
  /**
   * The transit modes it can carry, when it is sure (MTA buses: `['bus']`).
   * A source of street-level modes only is not woken by a regional view: its
   * vehicles are in city-zoom rooms alone (`liveRoomZoomsOf`). Absent: any.
   */
  transitModes?: readonly LiveTransitMode[];
  /** Whether it carries a whole network in its coverage (`LiveSource.completeness`). */
  completeness: 'network' | 'partial';
  /**
   * What is still open outside the code before this source may be served —
   * the licence allows it, but the operator asks to be contacted first, or a
   * form must be filed. `LIVE_SOURCES=all` leaves it out; naming its id
   * (`all,adsb-lol`) turns it on once the owner has done it.
   */
  awaiting?: string;
  /**
   * `true` when one poll answers for only PART of the source's data (a
   * regional aggregator asked about the watched areas): an entity missing from
   * a poll is then kept until it ages past `dropAfterSeconds`, rather than
   * removed as gone.
   */
  partialPolls?: boolean;
  /**
   * The operator's static GTFS, for line colours and for drawing vehicles on
   * their published shapes (`staticGtfs.ts`). Loaded when the source is first
   * watched, refreshed daily. Must be under the same licence as the feed.
   */
  staticGtfs?: StaticGtfsLocation;
  /**
   * Also serve this operator's STOPS and next DEPARTURES (`transit/`,
   * `docs/TRANSIT_NEARBY.md`). Needs a `staticGtfs` that is a whole archive
   * (`zip` without `only`, or `zips`), because departures are read from its
   * `stop_times.txt`; enrolled only after its size was measured. `realtimeUrls`
   * names the operator's `TripUpdates` feeds when they join its static trip
   * ids (keyless ones only); without them every departure is `scheduled`.
   */
  departures?: {
    realtimeUrls?: (settings: LiveAdapterSettings) => readonly string[];
  };
  create(settings: LiveAdapterSettings): LiveAdapter;
}

/** A source's upstream answered with something other than data. */
export class LiveUpstreamError extends Error {
  constructor(
    message: string,
    /** Seconds the upstream asked us to wait (a `Retry-After`), when it did. */
    readonly retryAfterSeconds: number | null = null,
    /** The HTTP status, when there was one. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'LiveUpstreamError';
  }
}
