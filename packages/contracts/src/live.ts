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
 * {@link LIVE_SOCKET_NAMESPACE}, in rooms keyed by a web-mercator tile — at
 * a zoom per kind ({@link LIVE_ROOM_ZOOMS}) — and a kind, so a client
 * receives only the kinds it asked for, in the tiles it is looking at. The
 * messages are the schemas below.
 */

import { z } from 'zod';
import { type GeoBoundingBox, geoBoundingBoxSchema, geoCoordinateSchema } from './geo';
import {
  LIVE_KINDS,
  type LiveKind,
  liveKindSchema,
  liveShapeIdSchema,
  liveSourceIdSchema,
} from './live-source';
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

/** `#RRGGBB`. */
const hexColorSchema = z.string().regex(/^#[0-9A-F]{6}$/, 'must be #RRGGBB');

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
  /** The line's colour, `#RRGGBB`, from the operator's static GTFS. */
  lineColor: hexColorSchema.nullable(),
  /** Text drawn on {@link lineColor}, `#RRGGBB`. */
  lineTextColor: hexColorSchema.nullable(),
  /**
   * Where this report lies on the operator's OWN published shape
   * (`shapes.txt`) — a display aid, not a correction: `position` stays
   * exactly as reported. Present only within the snap tolerance
   * (`GET /live/sources/{sourceId}/shapes/{shapeId}` serves the shape).
   */
  track: z
    .object({
      shapeId: liveShapeIdSchema,
      /** Metres along the shape to the point nearest the report. */
      alongMeters: z.number().min(0),
      /** Metres from the report to that point. */
      offsetMeters: z.number().min(0),
    })
    .nullable(),
  /**
   * `on_track`: `track` is set. `off_track`: the operator publishes shapes
   * and this report is farther than the tolerance from all of them — draw
   * it where reported, marked approximate, and never move it along a path.
   * `unknown`: no shape is known for it.
   */
  trackStatus: z.enum(['on_track', 'off_track', 'unknown']),
  /**
   * `reported`: the operator's own position fix (GPS or its signalling).
   * `estimated`: GoWay's estimate along the line from the operator's ARRIVAL
   * PREDICTIONS (`TripUpdate`s) — for networks that publish no positions
   * (New York's subway, AMB's buses). Never to be shown as a position fix.
   */
  positionBasis: z.enum(['reported', 'estimated']),
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
// Rooms: web-mercator tiles at a few zooms per kind
// ---------------------------------------------------------------------------

/**
 * The zooms of the tile grids each kind's rooms are keyed on, coarsest
 * first. Every entity is in one room at EACH of its kind's levels; a
 * subscription takes, per kind, the FINEST level whose rooms cover the
 * viewport in at most {@link LIVE_MAX_ROOM_TILES}. So a street view of New
 * York receives Midtown's buses, and a view of all Catalonia still receives
 * every Rodalies train — from coarser rooms.
 *
 * - aircraft, vessels: z7 — 2.8° of longitude, ~235 × 310 km at Barcelona.
 * - transit: z7 (a region or a country), z9 (~60 km: a metropolitan area)
 *   and z11 (~15 km: a borough) — but only RAIL is in the regional levels
 *   ({@link LIVE_REGIONAL_TRANSIT_MODES}); buses and every other street-level
 *   mode are in z11 rooms alone ({@link liveRoomZoomsOf}).
 * - bike share: z13 — ~3.7 km. Its docks matter only at street zooms (the map
 *   draws, and asks for, them from z15).
 */
export const LIVE_ROOM_ZOOMS: Readonly<Record<LiveKind, readonly number[]>> = {
  aircraft: [7],
  vessel: [7],
  transit: [7, 9, 11],
  bikeshare: [13],
};

/**
 * The transit modes a REGIONAL view carries: trains and metros — Rodalies
 * across Catalonia, the LIRR across Long Island. A bus, tram, ferry, cable car
 * or vehicle of unknown mode is a street-level thing, drawn at city zoom only:
 * a regional view of New York would otherwise carry every one of the MTA's
 * ~6,000 buses (~205 KiB, then ~132 KiB every 15 s).
 */
export const LIVE_REGIONAL_TRANSIT_MODES: readonly LiveTransitMode[] = ['rail', 'subway'];

/** Whether a transit mode is in the regional room levels ({@link LIVE_REGIONAL_TRANSIT_MODES}). */
export function isRegionalTransitMode(mode: LiveTransitMode): boolean {
  return LIVE_REGIONAL_TRANSIT_MODES.includes(mode);
}

/**
 * The room levels an entity is in, coarsest first: its kind's
 * ({@link LIVE_ROOM_ZOOMS}), except that a street-level transit mode is only
 * in the finest.
 */
export function liveRoomZoomsOf(entity: {
  kind: LiveKind;
  mode?: LiveTransitMode;
}): readonly number[] {
  const levels = LIVE_ROOM_ZOOMS[entity.kind];
  if (entity.kind === 'transit' && entity.mode && !isRegionalTransitMode(entity.mode))
    return levels.slice(-1);
  return levels;
}

/**
 * The map zoom from which a client asks for an operator's track shapes
 * (`GET /live/sources/:id/shapes/:shapeId`): below it a train is a few pixels
 * and its curve invisible. A view at this zoom takes the finest transit
 * rooms, so only those rooms can use shapes.
 */
export const LIVE_SHAPES_MIN_ZOOM = 12;

/**
 * The most rooms one subscription may cover, PER KIND, at the level it
 * takes. A kind whose COARSEST level still needs more is left out of the
 * subscription (`kinds` says which were kept); if every kind is, the answer is
 * `too_wide` and the client says "zoom in". 20 z7 tiles is roughly a z8
 * desktop viewport — below that the map is a continent.
 */
export const LIVE_MAX_ROOM_TILES = 20;

/** A room tile, `z/x/y`, at one of the {@link LIVE_ROOM_ZOOMS}. */
export const liveTileKeySchema = z
  .string()
  .regex(/^(7|9|11|13)\/\d{1,5}\/\d{1,5}$/, 'must be a live tile');

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

function finest(kind: LiveKind): number {
  const levels = LIVE_ROOM_ZOOMS[kind];
  return levels[levels.length - 1] as number;
}

/** The room tile a position of a kind falls in, at one of its levels (default: the finest). */
export function liveTileOf(
  position: { latitude: number; longitude: number },
  kind: LiveKind,
  zoom: number = finest(kind),
): string {
  const n = 2 ** zoom;
  return `${zoom}/${tileX(position.longitude, n)}/${tileY(position.latitude, n)}`;
}

/**
 * The room tiles a position of a kind falls in: one per level, coarsest
 * first. With a transit `mode`, only that mode's levels ({@link liveRoomZoomsOf}).
 */
export function liveTilesOf(
  position: { latitude: number; longitude: number },
  kind: LiveKind,
  mode?: LiveTransitMode,
): string[] {
  return liveRoomZoomsOf(mode ? { kind, mode } : { kind }).map((zoom) =>
    liveTileOf(position, kind, zoom),
  );
}

function tilesAt(box: GeoBoundingBox, zoom: number): string[] | null {
  const n = 2 ** zoom;
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
  for (const x of columns) for (let y = yMin; y <= yMax; y++) tiles.push(`${zoom}/${x}/${y}`);
  return tiles;
}

/**
 * A kind's room tiles for a box: at the finest of its levels that covers the
 * box in at most {@link LIVE_MAX_ROOM_TILES}, or `null` when even the
 * coarsest needs more. A box across the antimeridian (`west > east`) covers
 * both edges of the world.
 */
export function liveTilesFor(box: GeoBoundingBox, kind: LiveKind): string[] | null {
  const levels = LIVE_ROOM_ZOOMS[kind];
  for (let i = levels.length - 1; i >= 0; i--) {
    const tiles = tilesAt(box, levels[i] as number);
    if (tiles) return tiles;
  }
  return null;
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

/**
 * A server → client payload larger than this, serialised, travels as gzip
 * BYTES (a Socket.IO binary attachment) instead of JSON: a dense room's
 * snapshot is mostly repeated keys and shrinks ~8×. The client inflates it
 * (`@goway.to/sdk/live` → `unpackLivePayload`) and parses it as usual. Done in
 * the application because the backend's WebSocket server (Bun) does not
 * negotiate permessage-deflate.
 */
export const LIVE_PACKED_MIN_BYTES = 2048;

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
  /** server → client: {@link LiveSourcePage}, every feed, once on connect. */
  sources: 'live:sources',
  /**
   * server → client: one `LiveSource` whose status, freshness or count
   * changed — sent only to the sockets whose rooms meet that source, never
   * the whole list to everyone.
   */
  source: 'live:source',
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

/** One kind's room tiles in a subscription's answer. */
const liveRoomTilesSchema = z.array(liveTileKeySchema).max(LIVE_MAX_ROOM_TILES);

/**
 * The answer to a subscription.
 *
 * - `ok` — in exactly the rooms `tiles` lists, kind by kind (each kind's
 *   tiles at its own zoom); a snapshot follows for each new room. A kind asked
 *   for but missing from `tiles` covered more than {@link LIVE_MAX_ROOM_TILES}
 *   rooms and was left out.
 * - `too_wide` — every kind asked for covered more than
 *   {@link LIVE_MAX_ROOM_TILES} rooms; nothing is sent until a narrower box.
 * - `rate_limited` — subscriptions are arriving too fast; the previous rooms
 *   (listed) are kept, retry after `retryAfterSeconds`.
 * - `invalid` — the message did not parse; the previous rooms are kept.
 */
export const liveSubscriptionStateSchema = z.object({
  state: z.enum(['ok', 'too_wide', 'rate_limited', 'invalid']),
  /**
   * The rooms this connection is in NOW: per kind, its tiles. A client drops
   * whatever it holds in any other (tile, kind) — those rooms send nothing
   * more. Per kind because the kinds' levels differ: an aircraft room's z7
   * tile is not a transit room this connection is in.
   */
  tiles: z
    .object({
      aircraft: liveRoomTilesSchema,
      transit: liveRoomTilesSchema,
      bikeshare: liveRoomTilesSchema,
      vessel: liveRoomTilesSchema,
    } satisfies Record<LiveKind, typeof liveRoomTilesSchema>)
    .partial()
    .strict(),
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
 * A vehicle that only MOVED, compactly: `[id, latitude, longitude, heading,
 * speed, observedAt, alongMeters, offsetMeters]`. Everything else about it —
 * kind, line, colours, labels, its track's shape — is what the client already
 * holds; `headingDegrees`, `speedMetersPerSecond`, `observedAt` and, for a
 * vehicle on a track, `track.alongMeters`/`offsetMeters` are replaced (`null`
 * where it has no track). Most of a busy room's traffic is this: a bus is
 * ~450 bytes as an entity and ~80 as a move.
 */
export const liveMoveSchema = z.tuple([
  liveEntityIdSchema,
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(0).lt(360).nullable(),
  z.number().min(0).nullable(),
  instantSchema,
  z.number().min(0).nullable(),
  z.number().min(0).nullable(),
]);
export type LiveMove = z.infer<typeof liveMoveSchema>;

/**
 * What changed in one room since the last message: entities that arrived or
 * changed (`upserts`), ones that only moved (`moves`), and ids that left
 * (`removes` — gone from the feed, too old, or moved to another room, whose
 * own delta carries the upsert). A move names an entity the room's previous
 * messages delivered; a client that does not hold it ignores it.
 */
export const liveDeltaSchema = z.object({
  tile: liveTileKeySchema,
  kind: liveKindSchema,
  at: instantSchema,
  upserts: z.array(liveEntitySchema),
  moves: z.array(liveMoveSchema).default([]),
  removes: z.array(liveEntityIdSchema),
});
export type LiveDelta = z.infer<typeof liveDeltaSchema>;
