import { describe, expect, it } from 'bun:test';
import type { CaptureUploadPolicy } from '@goway.to/sdk';
import { describeMedia, hashChunks, mediaLocation, withProjection } from '../media.shared';
const image = { uri: 'file:///test.jpg', width: 100, height: 100 };
const policy = { photo: { contentTypes: ['image/jpeg'], maxByteSize: 50 }, video: { contentTypes: ['video/mp4'], maxByteSize: 100, maxDurationSeconds: 10 } } as CaptureUploadPolicy;

describe('bounded contribution media preparation', () => {
  it('hashes chunks identically to the SHA-256 known vector and honors cancellation', async () => {
    async function* bytes() { yield new TextEncoder().encode('a'); yield new TextEncoder().encode('bc'); }
    const controller = new AbortController();
    expect(await hashChunks(bytes(), controller.signal)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    controller.abort();
    await expect(hashChunks(bytes(), controller.signal)).rejects.toThrow();
  });
  it('rejects unsupported, empty, oversized and overlong media before registration', () => {
    expect(() => describeMedia(image, 0, policy)).toThrow();
    expect(() => describeMedia(image, 51, policy)).toThrow();
    expect(() => describeMedia({ ...image, mimeType: 'image/gif' }, 10, policy)).toThrow();
    expect(() => describeMedia({ ...image, type: 'video', mimeType: 'video/mp4', duration: 11000 }, 10, policy)).toThrow();
    expect(describeMedia(image, 10, policy).kind).toBe('photo');
  });
  it('suggests 360° only for a 2:1 file on a deployment that accepts it, and applies its limits', () => {
    const panoramic = { ...policy, equirectangular: { photo: { maxByteSize: 80, maxWidthPixels: 8000 }, video: { maxByteSize: 500, maxDurationSeconds: 30, maxWidthPixels: 7680 } } } as CaptureUploadPolicy;
    const pano = { ...image, width: 5760, height: 2880 };
    expect(describeMedia(pano, 10, policy)).toMatchObject({ projection: 'perspective', panoramaCandidate: false });
    expect(describeMedia(image, 10, panoramic)).toMatchObject({ projection: 'perspective', panoramaCandidate: false });
    const suggested = describeMedia(pano, 70, panoramic);
    expect(suggested).toMatchObject({ projection: 'equirectangular', panoramaCandidate: true });
    // Declared perspective, the same file must fit the ordinary limits.
    expect(() => withProjection(suggested, 'perspective', panoramic)).toThrow();
    expect(withProjection(describeMedia(pano, 10, panoramic), 'perspective', panoramic).projection).toBe('perspective');
    // A file that is not 2:1 cannot be declared 360°.
    expect(() => describeMedia(image, 10, panoramic, 'equirectangular')).toThrow();
    expect(() => describeMedia({ ...pano, width: 12000, height: 6000 }, 10, panoramic)).toThrow();
    const video = { ...pano, type: 'video' as const, mimeType: 'video/mp4' };
    expect(describeMedia({ ...video, duration: 20000 }, 400, panoramic).projection).toBe('equirectangular');
    expect(() => describeMedia({ ...video, duration: 31000 }, 400, panoramic)).toThrow();
  });
  it('uses media GPS with hemisphere correction and refuses invalid metadata', () => {
    expect(mediaLocation(image)).toBeNull();
    expect(mediaLocation({ ...image, exif: { GPSLatitude: 33, GPSLongitude: 70, GPSLatitudeRef: 'S', GPSLongitudeRef: 'W' } })?.coordinate)
      .toEqual({ latitude: -33, longitude: -70 });
    expect(mediaLocation({ ...image, exif: { GPSLatitude: NaN, GPSLongitude: 2 } })).toBeNull();
  });
});
