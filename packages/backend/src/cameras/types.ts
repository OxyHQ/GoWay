/**
 * The provider-adapter seam for public cameras.
 *
 * A provider is a {@link CameraProviderDefinition}: who runs the feed, under
 * what licence (`hub/provider.ts`), where it has cameras, whether GoWay may
 * serve its pictures itself, and a factory for the {@link CameraSource} that
 * speaks its format. Everything above the seam (the sync, the repository, the
 * routes, the relay) sees contract-shaped {@link CameraRecord}s and nothing of
 * DATEX II, an ArcGIS layer or a 511 JSON.
 *
 * ## A source's whole job
 *
 * Read the upstream catalogue and turn each entry into a record or REFUSE it
 * (`normalise.ts → accept`): an impossible coordinate, a missing picture URL or
 * an entry it does not recognise is counted in `skipped`, never coerced into a
 * plausible camera somewhere it is not.
 */

import type { CameraKind, CameraMedia, GeoBoundingBox, GeoCoordinate } from '@goway/contracts';
import type { HubProviderDefinition } from '../hub/provider';

/** What a source returns for one camera, before GoWay gives it an id. */
export interface CameraRecord {
  /** The provider's own id for the camera; unique within the provider. */
  sourceId: string;
  name: string;
  kind: CameraKind;
  position: GeoCoordinate;
  /** Degrees clockwise from true north; `null` when the upstream does not say. */
  heading: number | null;
  roadName: string | null;
  media: CameraMedia;
  /** Where the relay fetches the picture or playlist. Never published. */
  upstreamUrl: string;
  /** When the newest frame was taken, when the catalogue says. */
  frameAt: Date | null;
}

/** What a read may use. Injected, so every source is tested without a network. */
export interface CameraFetchContext {
  fetch: typeof fetch;
  signal: AbortSignal;
  now(): Date;
}

export interface CameraBatch {
  cameras: CameraRecord[];
  /**
   * The whole catalogue was read. Only then may a camera missing from it be
   * retired: a failed or partial read withdraws nothing.
   */
  complete: boolean;
  /** Entries read and refused, by reason: reported, never silent. */
  skipped: Record<string, number>;
  /** Units (a region, a page) that failed to read, with why. */
  failures: string[];
}

export interface CameraSource {
  read(context: CameraFetchContext): Promise<CameraBatch>;
}

/** Endpoint and identity, resolved from configuration. */
export interface CameraSourceSettings {
  url: string;
  userAgent: string;
}

export interface CameraProviderDefinition extends HubProviderDefinition {
  /** `null` for worldwide. */
  coverage: GeoBoundingBox | null;
  /**
   * `relay`: the licence allows GoWay to serve the pictures itself, so the
   * relay does. `catalogue-only`: GoWay lists the camera and serves nothing of
   * it. A provider whose terms were not read as allowing redistribution is
   * never `relay` (`licence.test.ts`).
   */
  redistribution: 'relay' | 'catalogue-only';
  create(settings: CameraSourceSettings): CameraSource;
}

/** An upstream answered with something other than data. */
export class CameraUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CameraUpstreamError';
  }
}
