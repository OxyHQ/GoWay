import type { ImagePickerAsset } from 'expo-image-picker';
import type { CaptureUploadPolicy } from '@goway.to/sdk';

/**
 * A finished guided recording, shaped like a picked video so it goes through
 * exactly the same select → hash → register → upload → finalize path.
 */
export interface GuidedRecording {
  asset: ImagePickerAsset;
  /** ISO 8601 instant the recording started. */
  capturedAt: string;
  frameRate?: number;
  /** The recorder stopped at the policy's size or duration limit, not at the user's tap. */
  stoppedAtLimit: boolean;
  /** Share of the recording the blur warning was up, 0–1. Absent where frames cannot be sampled. */
  blurryFraction?: number;
}

export interface GuidedCaptureProps {
  policy: CaptureUploadPolicy;
  /**
   * The user tapped Start. The ONE moment the contribution flow may ask for
   * location during a guided capture: the user is standing where it begins.
   */
  onStart: () => void;
  onRecorded: (recording: GuidedRecording) => void;
  onCancel: () => void;
}
