import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { CaptureLocationEvidenceInput, CaptureUploadPolicy, GeoCoordinate } from '@goway.to/sdk';

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

export function describeMedia(asset: ImagePickerAsset, size: number, policy: CaptureUploadPolicy): SelectedMedia {
  const kind = asset.type === 'video' ? 'video' : 'photo';
  const extension = (asset.fileName ?? asset.uri).split(/[?#]/)[0]?.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime' };
  const contentType = asset.mimeType || types[extension ?? ''];
  if (!contentType || !policy[kind].contentTypes.includes(contentType)) throw new MediaError('contribute.error.format');
  if (!Number.isSafeInteger(size) || size < 1 || size > policy[kind].maxByteSize) throw new MediaError('contribute.error.size');
  if (kind === 'video' && asset.duration && asset.duration / 1000 > policy.video.maxDurationSeconds) throw new MediaError('contribute.error.duration');
  return { asset, byteSize: size, contentType, kind };
}

export function mediaLocation(asset: ImagePickerAsset): CaptureLocation | null {
  const exif = asset.exif;
  if (!exif || typeof exif.GPSLatitude !== 'number' || typeof exif.GPSLongitude !== 'number') return null;
  const latitude = exif.GPSLatitudeRef === 'S' ? -Math.abs(exif.GPSLatitude) : exif.GPSLatitude;
  const longitude = exif.GPSLongitudeRef === 'W' ? -Math.abs(exif.GPSLongitude) : exif.GPSLongitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { origin: 'media_metadata', coordinate: { latitude, longitude } };
}
