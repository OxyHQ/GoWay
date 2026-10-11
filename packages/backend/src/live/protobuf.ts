/**
 * A minimal, bounds-checked protocol-buffers reader — enough for the
 * GTFS-Realtime `VehiclePosition` subset, and nothing more.
 *
 * Why not a library: `gtfs-realtime-bindings` drags in protobufjs and its
 * code generation for the one message GoWay reads, and `pbf` is ESM-only,
 * which this CommonJS backend would have to load through Bun's interop. The
 * wire format is small and stable (varint, 64-bit, length-delimited, 32-bit),
 * and a reader that THROWS on every malformed byte is exactly what a feed
 * adapter wants: a truncated body is a failed poll, never a half-read vehicle.
 *
 * Field numbers are GTFS-Realtime's (`gtfs-realtime.proto`, Apache-2.0);
 * unknown fields — extensions included — are skipped by wire type.
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufError';
  }
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

export class ProtobufReader {
  private position: number;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    private readonly end = bytes.byteLength,
  ) {
    this.position = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.position >= this.end;
  }

  /** An unsigned varint as a JS number (exact up to 2^53, which every GTFS-RT field is). */
  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.position >= this.end) throw new ProtobufError('truncated varint');
      const byte = this.bytes[this.position++] as number;
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 128;
    }
    throw new ProtobufError('varint too long');
  }

  /** `(fieldNumber, wireType)` of the next field. */
  tag(): { field: number; wire: number } {
    const key = this.varint();
    const field = Math.floor(key / 8);
    if (field === 0) throw new ProtobufError('field number 0');
    return { field, wire: key & 7 };
  }

  float(): number {
    this.need(4);
    const value = this.view.getFloat32(this.position, true);
    this.position += 4;
    return value;
  }

  double(): number {
    this.need(8);
    const value = this.view.getFloat64(this.position, true);
    this.position += 8;
    return value;
  }

  /** A length-delimited field's bounds, advancing past it. */
  bytesRange(): { start: number; end: number } {
    const length = this.varint();
    this.need(length);
    const start = this.position;
    this.position += length;
    return { start, end: this.position };
  }

  string(): string {
    const { start, end } = this.bytesRange();
    return new TextDecoder('utf-8', { fatal: false }).decode(this.bytes.subarray(start, end));
  }

  /** A reader over an embedded message. */
  message(): ProtobufReader {
    const { start, end } = this.bytesRange();
    return new ProtobufReader(this.bytes, start, end);
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.need(8);
        this.position += 8;
        return;
      case WIRE_BYTES:
        this.bytesRange();
        return;
      case WIRE_FIXED32:
        this.need(4);
        this.position += 4;
        return;
      default:
        throw new ProtobufError(`unsupported wire type ${wire}`);
    }
  }

  private need(length: number): void {
    if (length < 0 || this.position + length > this.end) throw new ProtobufError('truncated field');
  }
}

/** The GTFS-Realtime fields GoWay reads, as decoded. Every field may be absent. */
export interface GtfsVehiclePosition {
  entityId?: string;
  isDeleted?: boolean;
  tripId?: string;
  routeId?: string;
  vehicleId?: string;
  vehicleLabel?: string;
  latitude?: number;
  longitude?: number;
  bearing?: number;
  speed?: number;
  /** Seconds since the epoch. */
  timestamp?: number;
  /** `VehicleStopStatus`: 0 incoming at, 1 stopped at, 2 in transit to. */
  currentStatus?: number;
  /** The stop the status refers to. */
  stopId?: string;
}

/** One predicted stop of a trip. Times in seconds since the epoch. */
export interface GtfsStopTimeUpdate {
  stopId?: string;
  arrival?: number;
  departure?: number;
}

export interface GtfsTripUpdate {
  tripId?: string;
  routeId?: string;
  stops: GtfsStopTimeUpdate[];
}

export interface GtfsFeed {
  /** Seconds since the epoch. */
  headerTimestamp?: number;
  vehicles: GtfsVehiclePosition[];
  /** Arrival predictions (`TripUpdate`), when the feed carries them. */
  tripUpdates: GtfsTripUpdate[];
}

function expectWire(actual: number, expected: number, what: string): void {
  if (actual !== expected)
    throw new ProtobufError(`${what}: wire type ${actual}, expected ${expected}`);
}

function readTrip(reader: ProtobufReader, out: GtfsVehiclePosition): void {
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) out.tripId = reader.string();
    else if (field === 5 && wire === WIRE_BYTES) out.routeId = reader.string();
    else reader.skip(wire);
  }
}

function readVehicleDescriptor(reader: ProtobufReader, out: GtfsVehiclePosition): void {
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) out.vehicleId = reader.string();
    else if (field === 2 && wire === WIRE_BYTES) out.vehicleLabel = reader.string();
    else reader.skip(wire);
  }
}

function readPosition(reader: ProtobufReader, out: GtfsVehiclePosition): void {
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      expectWire(wire, WIRE_FIXED32, 'latitude');
      out.latitude = reader.float();
    } else if (field === 2) {
      expectWire(wire, WIRE_FIXED32, 'longitude');
      out.longitude = reader.float();
    } else if (field === 3 && wire === WIRE_FIXED32) out.bearing = reader.float();
    else if (field === 5 && wire === WIRE_FIXED32) out.speed = reader.float();
    else reader.skip(wire);
  }
}

function readVehiclePosition(reader: ProtobufReader, out: GtfsVehiclePosition): void {
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) readTrip(reader.message(), out);
    else if (field === 8 && wire === WIRE_BYTES) readVehicleDescriptor(reader.message(), out);
    else if (field === 2 && wire === WIRE_BYTES) readPosition(reader.message(), out);
    else if (field === 5 && wire === WIRE_VARINT) out.timestamp = reader.varint();
    else if (field === 4 && wire === WIRE_VARINT) out.currentStatus = reader.varint();
    else if (field === 7 && wire === WIRE_BYTES) out.stopId = reader.string();
    else reader.skip(wire);
  }
}

function readEventTime(reader: ProtobufReader): number | undefined {
  let time: number | undefined;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === WIRE_VARINT) time = reader.varint();
    else reader.skip(wire);
  }
  return time;
}

function readTripUpdate(reader: ProtobufReader): GtfsTripUpdate {
  const out: GtfsTripUpdate = { stops: [] };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) {
      const trip: GtfsVehiclePosition = {};
      readTrip(reader.message(), trip);
      if (trip.tripId) out.tripId = trip.tripId;
      if (trip.routeId) out.routeId = trip.routeId;
    } else if (field === 2 && wire === WIRE_BYTES) {
      const update = reader.message();
      const stop: GtfsStopTimeUpdate = {};
      while (!update.done) {
        const tag = update.tag();
        if (tag.field === 4 && tag.wire === WIRE_BYTES) stop.stopId = update.string();
        else if (tag.field === 2 && tag.wire === WIRE_BYTES)
          stop.arrival = readEventTime(update.message());
        else if (tag.field === 3 && tag.wire === WIRE_BYTES)
          stop.departure = readEventTime(update.message());
        else update.skip(tag.wire);
      }
      out.stops.push(stop);
    } else reader.skip(wire);
  }
  return out;
}

function readEntity(reader: ProtobufReader, feed: GtfsFeed): void {
  const out: GtfsVehiclePosition = {};
  let hasVehicle = false;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) out.entityId = reader.string();
    else if (field === 2 && wire === WIRE_VARINT) out.isDeleted = reader.varint() !== 0;
    else if (field === 4 && wire === WIRE_BYTES) {
      hasVehicle = true;
      readVehiclePosition(reader.message(), out);
    } else if (field === 3 && wire === WIRE_BYTES)
      feed.tripUpdates.push(readTripUpdate(reader.message()));
    else reader.skip(wire);
  }
  if (hasVehicle) feed.vehicles.push(out);
}

/** Decode a `FeedMessage`: its `VehiclePosition`s and `TripUpdate`s. Throws on malformed input. */
export function decodeGtfsRealtime(bytes: Uint8Array): GtfsFeed {
  const reader = new ProtobufReader(bytes);
  const feed: GtfsFeed = { vehicles: [], tripUpdates: [] };
  let sawHeader = false;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_BYTES) {
      sawHeader = true;
      const header = reader.message();
      while (!header.done) {
        const tag = header.tag();
        if (tag.field === 3 && tag.wire === WIRE_VARINT) feed.headerTimestamp = header.varint();
        else header.skip(tag.wire);
      }
    } else if (field === 2 && wire === WIRE_BYTES) {
      readEntity(reader.message(), feed);
    } else {
      reader.skip(wire);
    }
  }
  // `header` is REQUIRED in a FeedMessage; bytes without one are not a feed.
  if (!sawHeader) throw new ProtobufError('not a GTFS-Realtime FeedMessage (no header)');
  return feed;
}

/** Encode helpers for tests and fixtures: the inverse of the reader, for the same subset. */
export const protobufWriter = {
  varint(value: number): number[] {
    const out: number[] = [];
    let remaining = value;
    while (remaining >= 128) {
      out.push((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    out.push(remaining);
    return out;
  },
  key(field: number, wire: number): number[] {
    return protobufWriter.varint(field * 8 + wire);
  },
  bytes(field: number, payload: number[]): number[] {
    return [
      ...protobufWriter.key(field, WIRE_BYTES),
      ...protobufWriter.varint(payload.length),
      ...payload,
    ];
  },
  string(field: number, value: string): number[] {
    return protobufWriter.bytes(field, [...new TextEncoder().encode(value)]);
  },
  float(field: number, value: number): number[] {
    const buffer = new DataView(new ArrayBuffer(4));
    buffer.setFloat32(0, value, true);
    return [...protobufWriter.key(field, WIRE_FIXED32), ...new Uint8Array(buffer.buffer)];
  },
  uint(field: number, value: number): number[] {
    return [...protobufWriter.key(field, WIRE_VARINT), ...protobufWriter.varint(value)];
  },
};
