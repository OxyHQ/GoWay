/**
 * Every camera provider GoWay knows how to read, with its terms.
 *
 * A provider is listed here only after its licence was read and found to allow
 * what GoWay does with it (`docs/CAMERAS.md` → Providers has the evidence for
 * each, and the ones REJECTED and why). `licence.test.ts` refuses an entry
 * without a recorded check, and a provider that is `relay` without one.
 */

import type { CameraProviderDefinition } from './types';

export const CAMERA_PROVIDERS: readonly CameraProviderDefinition[] = [];

export function cameraProviderById(id: string): CameraProviderDefinition | undefined {
  return CAMERA_PROVIDERS.find((provider) => provider.id === id);
}
