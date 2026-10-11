/**
 * The operators' published shapes a live layer draws vehicles along, fetched
 * once each through the SDK (`goway.live.shape`) and kept while used.
 *
 * `get` never waits: it answers with the shape when it is here, and starts
 * fetching it when it is not. A vehicle whose shape is still on its way is
 * drawn where it was reported, unmoved, until it arrives.
 */
import { createGoWayClient, type LiveShape } from '@goway.to/sdk';

import type { ShapeSource } from './liveStore';
import type { TrackShape } from './track';

/** Shapes kept; a city view uses tens. The least recently used goes first. */
const MAX_SHAPES = 400;
/** A shape that failed to load is not asked for again for this long. */
const RETRY_AFTER_MS = 60_000;

export class ShapeCache implements ShapeSource {
  private readonly shapes = new Map<string, TrackShape>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly client;

  constructor(
    apiUrl: string,
    private readonly onLoaded: () => void,
    fetchShape?: (sourceId: string, shapeId: string) => Promise<LiveShape>,
  ) {
    const sdk = fetchShape ? null : createGoWayClient({ apiBaseUrl: apiUrl });
    this.client =
      fetchShape ??
      ((s: string, id: string) => (sdk as ReturnType<typeof createGoWayClient>).live.shape(s, id));
  }

  get(sourceId: string, shapeId: string): TrackShape | undefined {
    const key = `${sourceId} ${shapeId}`;
    const shape = this.shapes.get(key);
    if (shape) {
      // Re-insert: Map order is the recency order.
      this.shapes.delete(key);
      this.shapes.set(key, shape);
      return shape;
    }
    if (this.pending.has(key)) return undefined;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return undefined;
    this.pending.add(key);
    this.client(sourceId, shapeId)
      .then((loaded) => {
        this.shapes.set(key, {
          coordinates: loaded.coordinates,
          alongMeters: loaded.alongMeters,
          lengthMeters: loaded.lengthMeters,
        });
        this.failedAt.delete(key);
        while (this.shapes.size > MAX_SHAPES) {
          const oldest = this.shapes.keys().next().value;
          if (oldest === undefined) break;
          this.shapes.delete(oldest);
        }
        this.onLoaded();
      })
      .catch(() => {
        this.failedAt.set(key, Date.now());
      })
      .finally(() => this.pending.delete(key));
    return undefined;
  }
}
