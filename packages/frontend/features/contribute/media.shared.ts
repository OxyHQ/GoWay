import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { CaptureLocationEvidenceInput, CaptureProjection, CaptureUploadPolicy, GeoCoordinate } from '@goway.to/sdk';

/**
 * Where the contributor says the capture was taken: always a coordinate. The
 * contract also accepts raw `exifGps`, but this flow resolves the hemisphere
 * itself and shows the point on a map before anything is sent.
 */
export type CaptureLocation = CaptureLocationEvidenceInput & { coordinate: GeoCoordinate };

/** A media problem to show the contributor; `message` is its message key. */
export class MediaError extends Error {}

export interface SelectedMedia {
  asset: ImagePickerAsset;
  byteSize: number;
  contentType: string;
  kind: 'photo' | 'video';
  /** What the contribution will DECLARE. GoWay's privacy worker verifies it against the file. */
  projection: CaptureProjection;
  /** Whether the file is shaped like a 360° capture, so the contributor may declare it one. */
  panoramaCandidate: boolean;
}

export async function hashChunks(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
  const digest = sha256.create();
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    digest.update(chunk);
  }
  signal.throwIfAborted();
  return bytesToHex(digest.digest());
}

/** A full 360° panorama stored equirectangularly is exactly twice as wide as it is high. */
export function isTwoToOne(width: number, height: number): boolean {
  return width > 0 && height > 0 && Math.abs(width - 2 * height) <= Math.max(2, 0.01 * width);
}

/**
 * Validate a picked file against the policy for the projection it would be
 * declared with. A 2:1 file on a deployment that accepts 360° media is
 * suggested as one; that is a suggestion for the contributor to confirm, and
 * only ever a claim to GoWay, which checks the file's own 360° metadata.
 */
export function describeMedia(asset: ImagePickerAsset, size: number, policy: CaptureUploadPolicy, projection?: CaptureProjection): SelectedMedia {
  const kind = asset.type === 'video' ? 'video' : 'photo';
  const panoramaCandidate = policy.equirectangular !== undefined && isTwoToOne(asset.width, asset.height);
  const declared = projection ?? (panoramaCandidate ? 'equirectangular' : 'perspective');
  if (declared === 'equirectangular' && !panoramaCandidate) throw new MediaError('contribute.error.projection');
  const extension = (asset.fileName ?? asset.uri).split(/[?#]/)[0]?.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime' };
  const contentType = asset.mimeType || types[extension ?? ''];
  if (!contentType || !policy[kind].contentTypes.includes(contentType)) throw new MediaError('contribute.error.format');
  const panorama = declared === 'equirectangular' ? policy.equirectangular : undefined;
  const maxByteSize = panorama ? panorama[kind].maxByteSize : policy[kind].maxByteSize;
  if (!Number.isSafeInteger(size) || size < 1 || size > maxByteSize) throw new MediaError('contribute.error.size');
  const maxDuration = panorama ? panorama.video.maxDurationSeconds : policy.video.maxDurationSeconds;
  if (kind === 'video' && asset.duration && asset.duration / 1000 > maxDuration) throw new MediaError('contribute.error.duration');
  if (panorama && asset.width > panorama[kind].maxWidthPixels) throw new MediaError('contribute.error.resolution');
  return { asset, byteSize: size, contentType, kind, projection: declared, panoramaCandidate };
}

/** The same media declared the other way, re-checked against that projection's limits. */
export function withProjection(media: SelectedMedia, projection: CaptureProjection, policy: CaptureUploadPolicy): SelectedMedia {
  return describeMedia(media.asset, media.byteSize, policy, projection);
}

export function mediaLocation(asset: ImagePickerAsset): CaptureLocation | null {
  const exif = asset.exif;
  if (!exif || typeof exif.GPSLatitude !== 'number' || typeof exif.GPSLongitude !== 'number') return null;
  const latitude = exif.GPSLatitudeRef === 'S' ? -Math.abs(exif.GPSLatitude) : exif.GPSLatitude;
  const longitude = exif.GPSLongitudeRef === 'W' ? -Math.abs(exif.GPSLongitude) : exif.GPSLongitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { origin: 'media_metadata', coordinate: { latitude, longitude } };
}
