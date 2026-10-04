import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { CaptureUploadIntent, CaptureUploadPolicy } from '@goway.to/sdk';
import { describeMedia, hashChunks, type SelectedMedia } from './media.shared';

export async function selectMedia(asset: ImagePickerAsset, policy: CaptureUploadPolicy): Promise<SelectedMedia> {
  return describeMedia(asset, new File(asset.uri).size, policy);
}
export async function hashMedia(media: SelectedMedia, signal: AbortSignal): Promise<string> {
  async function* chunks() {
    const file = new File(media.asset.uri).open();
    try {
      for (let remaining = media.byteSize; remaining > 0;) {
        signal.throwIfAborted();
        const chunk = file.readBytes(Math.min(remaining, 1024 * 1024));
        if (chunk.length === 0) throw new Error('The selected file could not be read.');
        remaining -= chunk.length;
        yield chunk;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally { file.close(); }
  }
  return hashChunks(chunks(), signal);
}
export async function uploadMedia(media: SelectedMedia, upload: CaptureUploadIntent, signal: AbortSignal): Promise<void> {
  // Expo accepts File natively; React Native's global Blob type adds a legacy image field.
  const body = new File(media.asset.uri) as unknown as BodyInit;
  const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body, signal, credentials: 'omit', redirect: 'error' });
  if (!response.ok && response.status !== 412) throw new Error('The upload failed. You can retry this contribution.');
}
