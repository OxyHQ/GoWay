import type { ImagePickerAsset } from 'expo-image-picker';
import type { CaptureUploadIntent, CaptureUploadPolicy } from '@goway.to/sdk';
import { describeMedia, hashChunks, type SelectedMedia } from './media.shared';

async function source(asset: ImagePickerAsset): Promise<Blob> {
  if (asset.file) return asset.file;
  const response = await fetch(asset.uri);
  if (!response.ok) throw new Error('The selected file is no longer available.');
  return response.blob();
}
export async function selectMedia(asset: ImagePickerAsset, policy: CaptureUploadPolicy): Promise<SelectedMedia> {
  return describeMedia(asset, (await source(asset)).size, policy);
}
export async function hashMedia(media: SelectedMedia, signal: AbortSignal): Promise<string> {
  const blob = await source(media.asset);
  async function* chunks() {
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      signal.throwIfAborted();
      yield new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
    }
  }
  return hashChunks(chunks(), signal);
}
export async function uploadMedia(media: SelectedMedia, upload: CaptureUploadIntent, signal: AbortSignal): Promise<void> {
  const headers = Object.fromEntries(Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== 'content-length'));
  // The browser supplies Content-Length from the Blob; scripts cannot set it.
  const response = await fetch(upload.url, { method: 'PUT', headers, body: await source(media.asset), signal, credentials: 'omit', redirect: 'error' });
  // A retry can find its immutable object already stored. Finalize verifies its checksum.
  if (!response.ok && response.status !== 412) throw new Error('The upload failed. You can retry this contribution.');
}
