/**
 * Guided capture, web: `getUserMedia` + `MediaRecorder`, with live coaching.
 *
 * The full experience lives here because the browser hands us the preview's
 * pixels: four times a second the centre of the frame is drawn into a small
 * canvas and scored for sharpness and brightness (`sharpness.ts`), and the
 * coach (`coach.ts`) turns those scores into warnings.
 *
 * Camera controls are locked through the MediaStream Image Capture
 * extensions where the browser and camera expose them (Chrome on Android, in
 * practice); everywhere else the user is told what could not be locked.
 *
 * No audio is requested: it is useless to reconstruction and it is other
 * people's conversations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import { GuidedOverlay, type GuidedPhase } from './GuidedOverlay';
import {
  lockHeld, lockNoticeKeys, lockReport, lockSteps, pickRecorderType, reachedLimit, recordingBudget, RESOLUTION_PIXELS,
  type GuidedResolution, type LockCapabilities, type LockFeature, type LockReport, type LockSettings,
} from './recording';
import { centreCrop, frameSignals, sampleSize } from './sharpness';
import type { GuidedCaptureProps } from './types';
import { useGuidedSession } from './useGuidedSession';

const SAMPLE_MS = 250;

async function openCamera(resolution: GuidedResolution): Promise<MediaStream> {
  const { width, height } = RESOLUTION_PIXELS[resolution];
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    });
  } catch (error) {
    // `ideal` should never over-constrain, but some browsers still refuse; any camera beats none.
    if ((error as DOMException)?.name !== 'OverconstrainedError') throw error;
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
}

/** Lock what the track can lock, one control at a time, keeping only what the settings confirm. */
async function lockControls(track: MediaStreamTrack): Promise<LockFeature[]> {
  const capabilities = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as LockCapabilities;
  const applied: LockFeature[] = [];
  for (const step of lockSteps(capabilities, track.getSettings() as LockSettings)) {
    try {
      await track.applyConstraints({ advanced: [step.constraint as MediaTrackConstraintSet] });
      if (lockHeld(step, track.getSettings() as unknown as Record<string, unknown>)) applied.push(step.feature);
    } catch {
      // This control stays on auto; the notice says so.
    }
  }
  return applied;
}

type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void>; unlock?: () => void };

/**
 * Best effort, on touch devices only: full screen, then a landscape lock.
 * Must be called synchronously inside the tap, which is what browsers
 * require of `requestFullscreen`. Where either is refused, the portrait
 * warning still does the job.
 */
function enterLandscape() {
  if (typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches) return;
  const root = document.documentElement;
  if (typeof root.requestFullscreen !== 'function') return;
  root.requestFullscreen({ navigationUI: 'hide' })
    .then(() => (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape'))
    .catch(() => {});
}

function exitLandscape() {
  try { (screen.orientation as LockableOrientation | undefined)?.unlock?.(); } catch { /* not locked */ }
  if (typeof document !== 'undefined' && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

export function GuidedCapture({ policy, onStart, onRecorded, onCancel }: GuidedCaptureProps) {
  const { t } = useTranslation();
  const session = useGuidedSession();
  const { start: startSession, stop: stopSession, sample, elapsedNow, summary } = session;
  const budget = useMemo(() => recordingBudget(policy.video), [policy.video]);
  const recorderType = useMemo(() => (typeof MediaRecorder === 'undefined' ? null
    : pickRecorderType((type) => MediaRecorder.isTypeSupported(type), policy.video.contentTypes, budget.resolution)), [policy.video.contentTypes, budget.resolution]);
  const [phase, setPhase] = useState<GuidedPhase>('starting');
  const [error, setError] = useState<string>();
  const [locks, setLocks] = useState<LockReport | null>(null);
  const [portrait, setPortrait] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);

  const fail = useCallback((key: string) => { setError(t(key)); setPhase('error'); }, [t]);
  const unsupported = !recorderType ? 'contribute.guided.error.format'
    : typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia ? 'contribute.guided.error.camera' : null;

  // The camera opens because the user chose guided capture; nothing here asks for location.
  useEffect(() => {
    if (unsupported) return;
    let disposed = false;
    openCamera(budget.resolution).then((opened) => {
      if (disposed) { opened.getTracks().forEach((track) => track.stop()); return; }
      stream.current = opened;
      if (video.current) {
        video.current.srcObject = opened;
        void video.current.play().catch(() => {});
      }
      setPhase('ready');
    }).catch((e: unknown) => {
      if (disposed) return;
      const name = (e as DOMException)?.name;
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'contribute.guided.error.permission' : 'contribute.guided.error.camera');
    });
    return () => {
      disposed = true;
      discard.current = true;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      exitLandscape();
    };
  }, [budget.resolution, unsupported, fail]);

  // Sample the preview: orientation always, sharpness and brightness while recording.
  useEffect(() => {
    if (phase !== 'ready' && phase !== 'recording') return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const timer = setInterval(() => {
      const element = video.current;
      if (!element || element.readyState < 2 || element.videoWidth === 0) return;
      setPortrait(element.videoHeight > element.videoWidth);
      if (phase !== 'recording' || !context) return;
      const crop = centreCrop(element.videoWidth, element.videoHeight);
      const size = sampleSize(crop.width, crop.height);
      if (canvas.width !== size.width || canvas.height !== size.height) { canvas.width = size.width; canvas.height = size.height; }
      try {
        context.drawImage(element, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
        sample(frameSignals(context.getImageData(0, 0, size.width, size.height).data, size.width, size.height));
      } catch {
        // A frame that cannot be read is skipped; the coach tolerates gaps.
      }
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [phase, sample]);

  async function start() {
    const opened = stream.current;
    const track = opened?.getVideoTracks()[0];
    if (!opened || !track || !recorderType || phase !== 'ready') return;
    enterLandscape();
    setLocks(lockReport(await lockControls(track)));

    let next: MediaRecorder;
    try {
      next = new MediaRecorder(opened, { mimeType: recorderType.recorderType, videoBitsPerSecond: budget.bitsPerSecond });
    } catch {
      fail('contribute.guided.error.format');
      return;
    }
    const chunks: Blob[] = [];
    let bytes = 0;
    let stoppedAtLimit = false;
    const startedAt = new Date();
    next.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (next.state === 'recording' && reachedLimit(budget, elapsedNow(), bytes)) {
        stoppedAtLimit = true;
        setPhase('saving');
        next.stop();
      }
    };
    next.onerror = () => { discard.current = true; fail('contribute.guided.error.recording'); };
    next.onstop = () => {
      const seconds = elapsedNow();
      stopSession();
      exitLandscape();
      recorder.current = null;
      if (discard.current) return;
      if (chunks.length === 0) { fail('contribute.guided.error.recording'); return; }
      const settings = track.getSettings();
      const fileName = `guided-capture-${startedAt.toISOString().replace(/[:.]/g, '-')}.mp4`;
      const file = new File(chunks, fileName, { type: recorderType.contentType });
      onRecorded({
        asset: {
          uri: URL.createObjectURL(file),
          file,
          fileName,
          fileSize: file.size,
          type: 'video',
          mimeType: recorderType.contentType,
          width: video.current?.videoWidth || settings.width || 0,
          height: video.current?.videoHeight || settings.height || 0,
          duration: Math.round(seconds * 1000),
        },
        capturedAt: startedAt.toISOString(),
        ...(settings.frameRate ? { frameRate: settings.frameRate } : {}),
        stoppedAtLimit,
        blurryFraction: summary().blurryFraction,
      });
    };

    discard.current = false;
    recorder.current = next;
    startSession();
    // One-second chunks: the size check runs every second, and a failure
    // late in a long walk loses at most a second rather than everything.
    next.start(1000);
    setPhase('recording');
    onStart();
  }

  function stop() {
    if (recorder.current?.state === 'recording') {
      setPhase('saving');
      recorder.current.stop();
    }
  }

  function cancel() {
    discard.current = true;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    onCancel();
  }

  const notices = locks ? lockNoticeKeys(locks).map((key) => t(key)) : [];
  return <View className="flex-1 bg-background">
    <video
      ref={video}
      autoPlay
      playsInline
      muted
      aria-hidden
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
    />
    <GuidedOverlay
      phase={unsupported ? 'error' : phase}
      session={session}
      budget={budget}
      portrait={portrait}
      notices={notices}
      error={unsupported ? t(unsupported) : error}
      onStart={() => void start()}
      onStop={stop}
      onCancel={cancel}
    />
  </View>;
}
