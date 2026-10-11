/**
 * GoWay Live — real things moving on the map, from open real-time feeds.
 *
 * Aircraft, public-transport vehicles, bike-share stations and ships, each
 * normalised from a third party's open feed into ONE GoWay shape. The provider
 * (adsb.lol, a GTFS-Realtime feed, a GBFS system, Digitraffic) is a replaceable
 * adapter behind these schemas; none of their field names appear here.
 *
 * ## Real data, shown as real
 *
 * Every entity carries the instant its SOURCE observed it (`observedAt`) and
 * the source it came from (`sourceId`, resolved against {@link LiveSource} for
 * the operator, licence and credit). Nothing here is simulated, interpolated
 * or predicted: a client that animates between fixes does so on its own
 * account and within the bound the source declares
 * ({@link LiveSource.staleAfterSeconds}), and must show an entity older than
 * that as stale rather than move it.
 *
 * ## Never history, never the viewer
 *
 * Positions are transient: the server holds the latest fix per entity in
 * memory and nothing else, and never writes one to a database. A subscription
 * names a map VIEWPORT, which is not the viewer's location — but it is still
 * nobody's business, so it is neither stored nor logged.
 *
 * ## Transport
 *
 * `GET /api/v1/live/sources` (HTTP, in `API_OPERATIONS`) lists the sources and
 * their freshness. Positions travel over Socket.IO, namespace
 * {@link LIVE_SOCKET_NAMESPACE}, in rooms keyed by a {@link LIVE_ROOM_ZOOM}
 * web-mercator tile and a kind — so a client receives only the kinds it asked
 * for, in the tiles it is looking at. The messages are the schemas below.
 */

import { z } from 'zod';
import { type GeoBoundingBox, geoBoundingBoxSchema, geoCoordinateSchema } from './geo';
import { LIVE_KINDS, liveKindSchema, liveSourceIdSchema } from './live-source';
import { instantSchema } from './time';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** A transit vehicle's mode, as its source declares it (GTFS `route_type` terms). */
export const LIVE_TRANSIT_MODES = [
  'bus',
  'tram',
  'subway',
  'rail',
  'ferry',
  'cable',
  'other',
] as const;
export type LiveTransitMode = (typeof LIVE_TRANSIT_MODES)[number];

/**
 * An entity id: `<sourceId>:<the provider's own id>`. Opaque to a client.
 *
 * Scoped by source on purpose: two feeds may both carry a vehicle `1234`, and
 * one aircraft heard by two aggregators is two entities rather than a merge
 * GoWay cannot verify.
 */
export const liveEntityIdSchema = z.string().min(3).max(160);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Degrees clockwise from true north, `[0, 360)`. */
const headingSchema = z.number().min(0).lt(360);

/** Short display text from a feed: trimmed, bounded, never empty. */
const feedText = (max: number) => z.string().trim().min(1).max(max);

const liveEntityBase = {
  id: liveEntityIdSchema,
  sourceId: liveSourceIdSchema,
  position: geoCoordinateSchema,
  /** Course over ground (track), or the vehicle's bearing; `null` when not reported. */
  headingDegrees: headingSchema.nullable(),
  /** Ground speed; `null` when not reported. */
  speedMetersPerSecond: z.number().min(0).max(1200).nullable(),
  /** When the SOURCE observed this position — never when GoWay received it. */
  observedAt: instantSchema,
};

/** An aircraft position, from ADS-B or MLAT. */
export const liveAircraftSchema = z.object({
  ...liveEntityBase,
  kind: z.literal('aircraft'),
  /** The 24-bit ICAO address, lower-case hex. */
  icao24: z.string().regex(/^~?[0-9a-f]{6}$/),
  /** The flight's callsign as broadcast (`VLG12PY`), or `null`. */
  callsign: feedText(16).nullable(),
  /** Registration (`EC-MQB`), where the aggregator knows it. */
  registration: feedText(16).nullable(),
  /** ICAO type designator (`A321`), where the aggregator knows it. */
  typeCode: feedText(8).nullable(),
  /**
   * Altitude above mean sea level in metres: GNSS (`geometric`) when the
   * aircraft reports it, else pressure altitude (`barometric`), else `null`.
   * Always `0` with `onGround`.
   */
  altitudeMeters: z.number().min(-500).max(30_000).nullable(),
  altitudeReference: z.enum(['geometric', 'barometric']).nullable(),
  /** Positive climbing. */
  verticalRateMetersPerSecond: z.number().min(-200).max(200).nullable(),
  onGround: z.boolean(),
});
export type LiveAircraft = z.infer<typeof liveAircraftSchema>;

/** A public-transport vehicle. */
export const liveTransitVehicleSchema = z.object({
  ...liveEntityBase,
  kind: z.literal('transit'),
  mode: z.enum(LIVE_TRANSIT_MODES),
  /** The operator's name, from the source's configuration (`Renfe Cercanías`). */
  operator: feedText(80),
  /** The line as riders know it (`R2N`, `M15`), or the route id when that is all there is. */
  line: feedText(32).nullable(),
  /** Where it is going, when the feed says. */
  headsign: feedText(80).nullable(),
  /** The vehicle's own label or number, when the feed publishes one. */
  vehicleLabel: feedText(40).nullable(),
});
export type LiveTransitVehicle = z.infer<typeof liveTransitVehicleSchema>;

/** A bike-share station and its availability. `observedAt` is the station's last report. */
export const liveBikeshareStationSchema = z.object({
  ...liveEntityBase,
  kind: z.literal('bikeshare'),
  /** The operator's name, from the source's configuration (`Bicing`). */
  operator: feedText(80),
  name: feedText(120),
  /** Every rentable vehicle docked here, electric included. */
  bikesAvailable: z.number().int().min(0).max(10_000),
  /** Of those, electric — `null` when the system does not say. */
  ebikesAvailable: z.number().int().min(0).max(10_000).nullable(),
  docksAvailable: z.number().int().min(0).max(10_000).nullable(),
  capacity: z.number().int().min(0).max(10_000).nullable(),
  /** The station is renting / accepting returns right now. */
  renting: z.boolean(),
  returning: z.boolean(),
});
export type LiveBikeshareStation = z.infer<typeof liveBikeshareStationSchema>;

/** A ship, from AIS. */
export const liveVesselSchema = z.object({
  ...liveEntityBase,
  kind: z.literal('vessel'),
  /** Maritime Mobile Service Identity, nine digits. */
  mmsi: z.string().regex(/^\d{9}$/),
  /** The vessel's name, when its static report has been received. */
  name: feedText(40).nullable(),
  /** AIS navigational status in words (`under way using engine`), or `null`. */
  navigationalStatus: feedText(48).nullable(),
  /** Destination as typed by the crew, verbatim, when known. */
  destination: feedText(40).nullable(),
});
export type LiveVessel = z.infer<typeof liveVesselSchema>;

/** Any live entity, discriminated by `kind`. */
export const liveEntitySchema = z.discriminatedUnion('kind', [
  liveAircraftSchema,
  liveTransitVehicleSchema,
  liveBikeshareStationSchema,
  liveVesselSchema,
]);
export type LiveEntity = z.infer<typeof liveEntitySchema>;

// ---------------------------------------------------------------------------
// Rooms: web-mercator tiles at one zoom
// ---------------------------------------------------------------------------

/**
 * The zoom of the tile grid rooms are keyed on. A z7 tile is 2.8° of
 * longitude — about 235 × 310 km at Barcelona — so a city view is one or two
 * rooms, and an aircraft crossing a room boundary changes room every few
 * minutes rather than every few seconds.
 */
export const LIVE_ROOM_ZOOM = 7;

/**
 * The most rooms one subscription may cover. A wider viewport is refused with
 * `too_wide` and the client says "zoom in": 20 z7 tiles is roughly a z8
 * desktop viewport, and below that the map is a continent, where tens of
 * thousands of moving dots are noise rather than information.
 */
export const LIVE_MAX_ROOM_TILES = 20;

/** A room tile, `7/x/y`. */
export const liveTileKeySchema = z.string().regex(/^7\/\d{1,3}\/\d{1,3}$/, 'must be a live tile');

const MAX_MERCATOR_LATITUDE = 85.051129;

function tileX(longitude: number, n: number): number {
  const x = Math.floor(((longitude + 180) / 360) * n);
  return Math.min(n - 1, Math.max(0, x));
}

function tileY(latitude: number, n: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const radians = (clamped * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * n,
  );
  return Math.min(n - 1, Math.max(0, y));
}

/** The room tile a position falls in. */
export function liveTileOf(position: { latitude: number; longitude: number }): string {
  const n = 2 ** LIVE_ROOM_ZOOM;
  return `${LIVE_ROOM_ZOOM}/${tileX(position.longitude, n)}/${tileY(position.latitude, n)}`;
}

/**
 * The room tiles a box covers, or `null` when that is more than
 * {@link LIVE_MAX_ROOM_TILES}. A box across the antimeridian (`west > east`)
 * covers both edges of the world.
 */
export function liveTilesFor(box: GeoBoundingBox): string[] | null {
  const n = 2 ** LIVE_ROOM_ZOOM;
  const yMin = tileY(box.north, n);
  const yMax = tileY(box.south, n);
  const columns: number[] = [];
  const pushRange = (from: number, to: number) => {
    for (let x = from; x <= to; x++) columns.push(x);
  };
  if (box.west <= box.east) {
    pushRange(tileX(box.west, n), tileX(box.east, n));
  } else {
    pushRange(tileX(box.west, n), n - 1);
    pushRange(0, tileX(box.east, n));
  }
  const rows = yMax - yMin + 1;
  if (rows * columns.length > LIVE_MAX_ROOM_TILES) return null;
  const tiles: string[] = [];
  for (const x of columns)
    for (let y = yMin; y <= yMax; y++) tiles.push(`${LIVE_ROOM_ZOOM}/${x}/${y}`);
  return tiles;
}

/** The box a room tile covers, in degrees. */
export function liveTileBounds(tile: string): GeoBoundingBox {
  const [z, x, y] = tile.split('/').map(Number) as [number, number, number];
  const n = 2 ** z;
  const latitudeOf = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: latitudeOf(y),
    south: latitudeOf(y + 1),
  };
}

// ---------------------------------------------------------------------------
// Socket.IO messages
// ---------------------------------------------------------------------------

/** The Socket.IO namespace. Open to signed-out visitors: the map is. */
export const LIVE_SOCKET_NAMESPACE = '/live';

/** Event names, in both directions. */
export const LIVE_SOCKET_EVENTS = {
  /** client → server: {@link LiveSubscription}. Replaces the previous one. */
  subscribe: 'live:subscribe',
  /** server → client: {@link LiveSubscriptionState}, after every subscribe. */
  subscription: 'live:subscription',
  /** server → client: {@link LiveSnapshot}, one per room joined. */
  snapshot: 'live:snapshot',
  /** server → client: {@link LiveDelta}, per room, as feeds answer. */
  delta: 'live:delta',
  /** server → client: {@link LiveSourcePage}, on connect and as statuses change. */
  sources: 'live:sources',
} as const;

/** What a client is looking at. The zoom is the camera's; the box is the visible area. */
export const liveSubscriptionSchema = geoBoundingBoxSchema
  .extend({
    zoom: z.number().min(0).max(24),
    /** The kinds to receive. Empty leaves every room: "show me nothing live". */
    kinds: z.array(liveKindSchema).max(LIVE_KINDS.length),
  })
  .strict()
  .refine((value) => value.south <= value.north, {
    message: 'south must not be north of north',
    path: ['south'],
  });
export type LiveSubscription = z.input<typeof liveSubscriptionSchema>;

/**
 * The answer to a subscription.
 *
 * - `ok` — in `tiles` × `kinds` rooms now; a snapshot follows for each new one.
 * - `too_wide` — the box covers more than {@link LIVE_MAX_ROOM_TILES} rooms;
 *   nothing is sent until a narrower one arrives.
 * - `rate_limited` — subscriptions are arriving too fast; the previous rooms
 *   (listed) are kept, retry after `retryAfterSeconds`.
 * - `invalid` — the message did not parse; the previous rooms are kept.
 */
export const liveSubscriptionStateSchema = z.object({
  state: z.enum(['ok', 'too_wide', 'rate_limited', 'invalid']),
  /**
   * The room tiles this connection is in NOW, and the kinds. A client drops
   * whatever it holds outside them: those rooms send nothing more.
   */
  tiles: z.array(liveTileKeySchema).max(LIVE_MAX_ROOM_TILES),
  kinds: z.array(liveKindSchema).max(LIVE_KINDS.length),
  retryAfterSeconds: z.number().int().min(1).nullable(),
});
export type LiveSubscriptionState = z.infer<typeof liveSubscriptionStateSchema>;

/** Every entity of one kind in one room, as of `at`. */
export const liveSnapshotSchema = z.object({
  tile: liveTileKeySchema,
  kind: liveKindSchema,
  /** The server's clock when this was sent: a client measures ages against it, not its own. */
  at: instantSchema,
  entities: z.array(liveEntitySchema),
});
export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;

/**
 * What changed in one room since the last message: entities that arrived or
 * moved (`upserts`) and ids that left (`removes` — gone from the feed, too old,
 * or moved to another room, whose own delta carries the upsert).
 */
export const liveDeltaSchema = z.object({
  tile: liveTileKeySchema,
  kind: liveKindSchema,
  at: instantSchema,
  upserts: z.array(liveEntitySchema),
  removes: z.array(liveEntityIdSchema),
});
export type LiveDelta = z.infer<typeof liveDeltaSchema>;
