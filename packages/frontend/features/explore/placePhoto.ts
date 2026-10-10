/**
 * A picked image, made safe to publish on a place.
 *
 * A phone photo carries its EXIF block, and the EXIF block carries where the
 * phone was when it took it. A place's gallery is public on Oxy's CDN, so an
 * image uploaded as picked would publish the contributor's position to anybody
 * — which is exactly what GoWay's privacy rule forbids keeping, let alone
 * publishing. Re-encoding through the image manipulator writes fresh pixels
 * with no metadata at all, so the location never leaves the device; capping
 * the long edge keeps an upload a gallery image rather than a 48-megapixel
 * original.
 */
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { PickedImage } from '@/lib/goway/queries';

/** The longest edge a gallery image is stored at, in pixels. */
const MAX_EDGE_PX = 2048;

/**
 * Ask for one image from the library and re-encode it without metadata, or
 * `null` when the person cancelled. No location permission is asked for: the
 * library picker needs none, and the re-encoded file carries none.
 */
export async function pickPlacePhoto(): Promise<PickedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    exif: false,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;

  const context = ImageManipulator.manipulate(asset.uri);
  const longest = Math.max(asset.width, asset.height);
  if (longest > MAX_EDGE_PX) {
    context.resize(asset.width >= asset.height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return { uri: saved.uri, type: 'image/jpeg', name: 'place-photo.jpg' };
}
