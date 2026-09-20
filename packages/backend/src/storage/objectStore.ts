/**
 * The object store, as a GoWay interface.
 *
 * S3 is a replaceable adapter, exactly like MapLibre, Photon and Valhalla are.
 * Feature code imports this interface; only `s3ObjectStore.ts` knows what an
 * AWS signature is. The epic uses AWS while its credits are useful and says so
 * out loud — which is a reason to keep the seam, not to skip it.
 *
 * ## The API never touches the bytes
 *
 * There is no `putObject` here and there must never be one. Media uploads go
 * directly from the contributor's device to the store using a scoped, expiring
 * target this interface ISSUES; routing them through the API process would make
 * one Express worker the bottleneck and the bandwidth bill for every
 * contribution, and it would put a 512 MB video in the memory of a process that
 * also answers map reads.
 *
 * ## The key is always the server's
 *
 * Every method takes a key the server generated. A client-chosen key is a path
 * traversal, a collision with another contributor's object, or a write outside
 * the prefix the store's own lifecycle backstop is configured on — and all
 * three are silent.
 */

/** A scoped, expiring permission to write exactly one object. */
export interface UploadTarget {
  /** Absolute URL the client PUTs to. */
  url: string;
  /** Headers the client must send verbatim; they are covered by the signature. */
  headers: Record<string, string>;
  /** When the store stops accepting this target. */
  expiresAt: Date;
}

/** What the store reports about an object that is actually there. */
export interface StoredObjectStat {
  byteSize: number;
  /** The store's own entity tag, when it provides one. Never trusted as a content hash. */
  etag?: string;
}

export interface UploadTargetRequest {
  /** Server-generated. See this module's header. */
  key: string;
  contentType: string;
  /** The exact byte count the target is signed for. */
  byteSize: number;
  /** Seconds the target stays valid. */
  ttlSeconds: number;
}

/**
 * Everything GoWay asks of an object store.
 *
 * Deliberately four methods. A store that can issue a write target, confirm an
 * object arrived, hand a reconstruction job short-lived read access and delete
 * is a store that can serve the entire capture lifecycle — and anything wider
 * would start encoding S3 concepts into the callers.
 */
export interface CaptureObjectStore {
  /** Issue a scoped, expiring upload target. Records nothing; the caller owns the row. */
  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget>;

  /**
   * Whether the bytes are actually there, and how many.
   *
   * This is what turns "the client said it finished" into a fact. Without it,
   * finalize is a client's word for it and an orphaned or truncated upload
   * becomes an asset GoWay believes in.
   */
  statObject(key: string): Promise<StoredObjectStat | null>;

  /**
   * A short-lived URL a reconstruction or privacy job may read the object with.
   *
   * Raw imagery is never a public URL (#13). Every read is scoped and expires,
   * which is why this returns a fresh URL rather than a durable path anything
   * could store.
   */
  createReadUrl(key: string, ttlSeconds: number): Promise<string>;

  /** Delete the bytes. Idempotent: deleting an absent object is a success. */
  deleteObject(key: string): Promise<void>;
}
