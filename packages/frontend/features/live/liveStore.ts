/**
 * The client's live state: the latest fix of every thing in the rooms it is
 * subscribed to, merged from snapshots and deltas, and sampled into drawable
 * points. Pure — no socket, no map, no React — so every rule is a test.
 *
 * ## What it keeps
 *
 * For each entity: its latest contract value, the room it came from and its
 * fix (on the server's clock). The previous fix is read once, when the next
 * arrives — for the course between them and the pace of the walk — and is not
 * kept; this is not a track.
 *
 * ## Rooms
 *
 * A snapshot is authoritative for its room (tile × kind): whatever the store
 * held there and the snapshot does not list is gone. A delta's `removes` only
 * remove an entity still filed under THAT room — an entity that moved rooms
 * may arrive in its new room's delta before the old room's remove does.
 */

import type { LiveEntity, LiveKind, LiveSource } from '@goway.to/sdk/live';

import {
  blend,
  derivedVelocity,
  extrapolationBoundSeconds,
  type Fix,
  type Freshness,
  freshnessOf,
  headingOf,
  opacityOf,
  positionAt,
  type Velocity,
  velocityOf,
} from './motion';
import { pointAlong, type TrackShape } from './track';

/** How long a correction (a new fix landing away from the prediction) is eased over. */
export const BLEND_MS = 900;

/**
 * The longest a thing WITHOUT a reported speed is walked from where it was
 * drawn to its new fix. Such a thing is never predicted: it moves along the
 * segment between two real positions, over the time the source took between
 * them, so it is always somewhere it really was within that interval — one
 * update behind, which its stated age already says.
 */
export const MAX_INTERPOLATION_MS = 30_000;

/** Bounds for a source the client has not heard about yet. */
const DEFAULT_STALE_SECONDS = 60;
const DEFAULT_DROP_SECONDS = 300;

interface Tracked {
  entity: LiveEntity;
  room: string;
  fix: Fix;
  /** From a REPORTED speed and course only; `null` means "never predicted". */
  velocity: Velocity | null;
  /** Course between the last two real fixes, for a thing that reports none. */
  derivedHeading: number | null;
  /** Where it was drawn when the latest fix arrived, and when (client clock). */
  blendFrom: { latitude: number; longitude: number } | null;
  blendStart: number;
  /** How long the walk to the new fix takes (see {@link MAX_INTERPOLATION_MS}). */
  blendMs: number;
  /** The last position handed out, for the next blend. */
  lastDrawn: { latitude: number; longitude: number } | null;
  /** The freshness it was last drawn at: going stale eases it back to its fix. */
  lastFreshness: Freshness | null;
  /** On a published track: the shape, and the distance along it at the fix. */
  track: { sourceId: string; shapeId: string; along: number } | null;
  /** Walking along the track: from this distance, since `blendStart`, over `blendMs`. */
  walkFrom: number | null;
  /** The distance along last drawn. */
  lastAlong: number | null;
}

/** Where a vehicle's operator publishes the shape it runs along. */
export interface ShapeSource {
  /** The shape, when loaded; `undefined` asks for it to be loaded. */
  get(sourceId: string, shapeId: string): TrackShape | undefined;
}

export interface LiveSample {
  entity: LiveEntity;
  latitude: number;
  longitude: number;
  heading: number | null;
  freshness: Freshness;
  opacity: number;
  /** Seconds since the source observed it, on the server's clock. */
  ageSeconds: number;
  moving: boolean;
  /** Drawn along its operator's published track: the shape and the distance along it. */
  onTrack: { shape: TrackShape; along: number } | null;
  /**
   * A transit vehicle NOT on a known track (farther from every published
   * shape than the tolerance, or none known): drawn exactly where reported,
   * never moved along a path, and marked approximate.
   */
  approximate: boolean;
}

function roomOf(tile: string, kind: LiveKind): string {
  return `${tile}|${kind}`;
}

export class LiveStore {
  private readonly tracked = new Map<string, Tracked>();
  private readonly sourcesById = new Map<string, LiveSource>();
  /** server clock − client clock, in ms. */
  private offset = 0;

  constructor(
    private readonly clientNow: () => number = Date.now,
    private readonly shapes: ShapeSource | null = null,
  ) {}

  get size(): number {
    return this.tracked.size;
  }

  serverNow(clientNow = this.clientNow()): number {
    return clientNow + this.offset;
  }

  /** Every message carries the server's `at`; the latest one sets the clock offset. */
  observeServerTime(at: string): void {
    const server = Date.parse(at);
    if (Number.isFinite(server)) this.offset = server - this.clientNow();
  }

  setSources(sources: readonly LiveSource[]): void {
    this.sourcesById.clear();
    for (const source of sources) this.sourcesById.set(source.id, source);
  }

  source(id: string): LiveSource | undefined {
    return this.sourcesById.get(id);
  }

  sources(): LiveSource[] {
    return [...this.sourcesById.values()];
  }

  applySnapshot(snapshot: {
    tile: string;
    kind: LiveKind;
    at: string;
    entities: readonly LiveEntity[];
  }): void {
    this.observeServerTime(snapshot.at);
    const room = roomOf(snapshot.tile, snapshot.kind);
    const listed = new Set(snapshot.entities.map((entity) => entity.id));
    for (const [id, item] of this.tracked) {
      if (item.room === room && !listed.has(id)) this.tracked.delete(id);
    }
    for (const entity of snapshot.entities) this.upsert(entity, room);
  }

  applyDelta(delta: {
    tile: string;
    kind: LiveKind;
    at: string;
    upserts: readonly LiveEntity[];
    removes: readonly string[];
  }): void {
    this.observeServerTime(delta.at);
    const room = roomOf(delta.tile, delta.kind);
    for (const id of delta.removes) {
      if (this.tracked.get(id)?.room === room) this.tracked.delete(id);
    }
    for (const entity of delta.upserts) this.upsert(entity, room);
  }

  /** Keep only the rooms the server says this connection is in. */
  retain(tiles: readonly string[], kinds: readonly LiveKind[]): void {
    const rooms = new Set(tiles.flatMap((tile) => kinds.map((kind) => roomOf(tile, kind))));
    for (const [id, item] of this.tracked) if (!rooms.has(item.room)) this.tracked.delete(id);
  }

  clear(): void {
    this.tracked.clear();
  }

  get(id: string): LiveEntity | undefined {
    return this.tracked.get(id)?.entity;
  }

  private bounds(entity: LiveEntity): { stale: number; drop: number } {
    const source = this.sourcesById.get(entity.sourceId);
    return {
      stale: source?.staleAfterSeconds ?? DEFAULT_STALE_SECONDS,
      drop: source?.dropAfterSeconds ?? DEFAULT_DROP_SECONDS,
    };
  }

  private upsert(entity: LiveEntity, room: string): void {
    const at = Date.parse(entity.observedAt);
    if (!Number.isFinite(at)) return;
    const fix: Fix = {
      latitude: entity.position.latitude,
      longitude: entity.position.longitude,
      at,
    };
    const existing = this.tracked.get(entity.id);
    if (existing && existing.fix.at > at) return; // an older fix arriving late
    const velocity = velocityOf(entity.speedMetersPerSecond, entity.headingDegrees);
    const derived =
      existing && existing.fix.at < at ? derivedVelocity(entity.kind, existing.fix, fix) : null;
    const now = this.clientNow();
    const moved =
      !existing ||
      existing.fix.at !== at ||
      existing.fix.latitude !== fix.latitude ||
      existing.fix.longitude !== fix.longitude;
    // A thing with a reported speed is dead-reckoned and only its corrections
    // are eased; one without is walked between its real fixes, at the pace the
    // source reported them.
    const walk =
      existing && !velocity
        ? Math.min(MAX_INTERPOLATION_MS, Math.max(BLEND_MS, at - existing.fix.at))
        : BLEND_MS;
    const track =
      entity.kind === 'transit' && entity.track
        ? {
            sourceId: entity.sourceId,
            shapeId: entity.track.shapeId,
            along: entity.track.alongMeters,
          }
        : null;
    // Along the same track, the walk starts where it was last drawn ON it.
    const sameTrack =
      track !== null &&
      existing?.track?.shapeId === track.shapeId &&
      existing.track.sourceId === track.sourceId &&
      existing.lastAlong !== null;
    this.tracked.set(entity.id, {
      track,
      walkFrom:
        moved && sameTrack ? existing.lastAlong : moved ? null : (existing?.walkFrom ?? null),
      lastAlong: sameTrack ? (existing?.lastAlong ?? null) : null,
      entity,
      room,
      fix,
      velocity,
      derivedHeading: headingOf(derived) ?? (moved ? null : (existing?.derivedHeading ?? null)),
      blendFrom: moved && existing ? existing.lastDrawn : (existing?.blendFrom ?? null),
      blendStart: moved ? now : (existing?.blendStart ?? now),
      blendMs: moved ? walk : (existing?.blendMs ?? BLEND_MS),
      lastDrawn: existing?.lastDrawn ?? null,
      lastFreshness: existing?.lastFreshness ?? null,
    });
  }

  /** One entity at `clientNow`; `null` once it has expired. */
  sampleOne(id: string, clientNow = this.clientNow()): LiveSample | null {
    const item = this.tracked.get(id);
    return item ? this.sampleTracked(item, clientNow) : null;
  }

  private sampleTracked(item: Tracked, clientNow: number): LiveSample | null {
    const serverNow = this.serverNow(clientNow);
    const { stale, drop } = this.bounds(item.entity);
    const ageSeconds = Math.max(0, (serverNow - item.fix.at) / 1000);
    const freshness = freshnessOf(ageSeconds, stale, drop);
    if (freshness === 'expired') return null;
    if (item.lastFreshness !== null && item.lastFreshness !== freshness && item.lastDrawn) {
      // Going stale moves it back from the prediction to its last real fix:
      // eased, so the correction reads as a correction rather than a glitch.
      item.blendFrom = item.lastDrawn;
      item.blendStart = clientNow;
      item.blendMs = BLEND_MS;
    }
    item.lastFreshness = freshness;
    const bound = extrapolationBoundSeconds(item.entity.kind, stale);
    const elapsed = clientNow - item.blendStart;
    const base = {
      entity: item.entity,
      freshness,
      opacity: opacityOf(freshness),
      ageSeconds,
    };

    // ── On a published track: one number, the distance along it ────────────
    const shape = item.track
      ? this.shapes?.get(item.track.sourceId, item.track.shapeId)
      : undefined;
    if (item.track && shape) {
      // A reported speed moves it forward along the line, briefly; nothing else predicts.
      const ahead =
        freshness === 'fresh' && item.velocity && item.entity.speedMetersPerSecond !== null
          ? item.entity.speedMetersPerSecond *
            Math.max(0, Math.min((serverNow - item.fix.at) / 1000, bound))
          : 0;
      const target = Math.min(shape.lengthMeters, item.track.along + ahead);
      const walking = item.walkFrom !== null && elapsed < item.blendMs;
      const along = walking
        ? (item.walkFrom as number) +
          (target - (item.walkFrom as number)) * Math.max(0, elapsed / item.blendMs)
        : target;
      item.lastAlong = along;
      const point = pointAlong(shape, along);
      item.lastDrawn = { latitude: point.latitude, longitude: point.longitude };
      return {
        ...base,
        latitude: point.latitude,
        longitude: point.longitude,
        heading: point.heading,
        moving: walking || ahead > 0,
        onTrack: { shape, along },
        approximate: false,
      };
    }

    // ── Transit off any known track: exactly where reported, never walked ──
    if (item.entity.kind === 'transit') {
      item.lastDrawn = { latitude: item.fix.latitude, longitude: item.fix.longitude };
      return {
        ...base,
        latitude: item.fix.latitude,
        longitude: item.fix.longitude,
        heading: item.entity.headingDegrees ?? item.derivedHeading,
        moving: false,
        onTrack: null,
        // On track but its shape still loading is not "approximate"; the
        // operator just has not been heard from yet.
        approximate: item.entity.trackStatus !== 'on_track',
      };
    }

    // ── Aircraft and ships: bounded dead reckoning, eased corrections ──────
    const target = positionAt(item.fix, item.velocity, serverNow, bound, freshness);
    const drawn = item.blendFrom
      ? blend(
          item.blendFrom,
          target,
          elapsed,
          item.blendMs,
          item.blendMs > BLEND_MS ? 'linear' : 'out',
        )
      : target;
    item.lastDrawn = drawn;
    const moving = freshness === 'fresh' && item.velocity !== null && ageSeconds < bound;
    return {
      ...base,
      latitude: drawn.latitude,
      longitude: drawn.longitude,
      heading: item.entity.headingDegrees ?? item.derivedHeading,
      moving: moving || (item.blendFrom !== null && elapsed < item.blendMs),
      onTrack: null,
      approximate: false,
    };
  }

  /**
   * Everything drawable at `clientNow`, of the given kinds. Expired entities
   * are removed as a side effect.
   */
  sample(kinds: ReadonlySet<LiveKind>, clientNow = this.clientNow()): LiveSample[] {
    const out: LiveSample[] = [];
    for (const [id, item] of this.tracked) {
      if (!kinds.has(item.entity.kind)) continue;
      const sample = this.sampleTracked(item, clientNow);
      if (!sample) {
        this.tracked.delete(id);
        continue;
      }
      out.push(sample);
    }
    return out;
  }
}
