/**
 * Guided capture, iOS and Android: `expo-camera`, with the coaching it allows.
 *
 * What native gets: the step plan and stretch timer, 4K (or the best the
 * device has) at a bitrate fitted to the upload policy, no audio, stabilisation
 * off, size and duration limits enforced by the recorder itself, a focus lock
 * on iOS, and on iOS a portrait warning plus an overlay that turns with the
 * phone (the app is portrait-locked, so the camera's motion-based orientation
 * is the only signal there is).
 *
 * What it does not get: live sharpness and exposure checks. `expo-camera`
 * exposes no preview frames — grabbing stills during a recording would
 * stutter the video — and it has no exposure lock. The user is told so
 * rather than shown a coach that is silently blind. Android has no
 * orientation signal under a portrait lock either, so it gets no portrait
 * warning.
 *
 * Its config plugin needs nothing from the app: Expo applies `expo-camera`'s
 * plugin automatically when the package is installed, which declares the
 * camera permission. Recording is muted, so the microphone is never asked for.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Camera, CameraView, type CameraOrientation } from 'expo-camera';
import { File } from 'expo-file-system';
import { useTranslation } from '@/lib/i18n';
import { GuidedOverlay, type GuidedPhase } from './GuidedOverlay';
import { lockNoticeKeys, lockReport, nativeRecording, recordingBudget } from './recording';
import type { GuidedCaptureProps } from './types';
import { useGuidedSession } from './useGuidedSession';

/** Keep the overlay upright when the phone is turned, though the app itself is portrait-locked. */
function Upright({ orientation, children }: { orientation: CameraOrientation | null; children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  // UIDeviceOrientation: `landscapeLeft` is the top of the phone pointing left,
  // so the content turns clockwise to stay upright.
  const turn = orientation === 'landscapeLeft' ? '90deg' : orientation === 'landscapeRight' ? '-90deg' : null;
  if (!turn) return <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>{children}</View>;
  return <View
    pointerEvents="box-none"
    style={{ position: 'absolute', width: height, height: width, left: (width - height) / 2, top: (height - width) / 2, transform: [{ rotate: turn }] }}
  >{children}</View>;
}

function discardFile(uri: string) {
  try { new File(uri).delete(); } catch { /* already gone */ }
}

export function GuidedCapture({ policy, onStart, onRecorded, onCancel }: GuidedCaptureProps) {
  const { t } = useTranslation();
  const session = useGuidedSession();
  const budget = useMemo(() => recordingBudget(policy.video), [policy.video]);
  const output = nativeRecording(Platform.OS);
  const accepted = policy.video.contentTypes.includes(output.contentType);
  const camera = useRef<CameraView>(null);
  const [permission, setPermission] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [phase, setPhase] = useState<GuidedPhase>('starting');
  const [error, setError] = useState<string>();
  const [orientation, setOrientation] = useState<CameraOrientation | null>(null);
  const discard = useRef(false);
  const userStopped = useRef(false);
  const recordingActive = useRef(false);
  /** The camera a recording was started on, for stopping it from cleanup. */
  const recorderView = useRef<CameraView | null>(null);

  function fail(key: string) { setError(t(key)); setPhase('error'); }

  useEffect(() => {
    if (!accepted) return;
    let mounted = true;
    // Asked because the user chose guided capture; the microphone is never asked for.
    Camera.requestCameraPermissionsAsync()
      .then(({ granted }) => {
        if (!mounted) return;
        setPermission(granted ? 'granted' : 'denied');
        if (!granted) { setError(t('contribute.guided.error.permission')); setPhase('error'); }
      })
      .catch(() => { if (mounted) { setError(t('contribute.guided.error.camera')); setPhase('error'); } });
    return () => {
      mounted = false;
      if (recordingActive.current) { discard.current = true; recorderView.current?.stopRecording(); }
    };
  }, [accepted, t]);

  async function start() {
    const view = camera.current;
    if (!view || phase !== 'ready') return;
    const startedAt = new Date();
    discard.current = false;
    userStopped.current = false;
    recordingActive.current = true;
    recorderView.current = view;
    session.start();
    setPhase('recording');
    onStart();
    try {
      const result = await view.recordAsync({
        maxDuration: budget.maxSeconds,
        maxFileSize: budget.stopAtBytes,
        // iOS applies `videoBitrate` only with an explicit codec.
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      const seconds = session.elapsedNow();
      recordingActive.current = false;
      session.stop();
      if (discard.current) { if (result?.uri) discardFile(result.uri); return; }
      if (!result?.uri) { fail('contribute.guided.error.recording'); return; }
      const fileName = `guided-capture-${startedAt.toISOString().replace(/[:.]/g, '-')}.${output.extension}`;
      onRecorded({
        asset: { uri: result.uri, fileName, type: 'video', mimeType: output.contentType, width: 0, height: 0, duration: Math.round(seconds * 1000) },
        capturedAt: startedAt.toISOString(),
        // The recorder ends by itself only at a limit (or when the camera is taken away).
        stoppedAtLimit: !userStopped.current,
      });
    } catch {
      recordingActive.current = false;
      session.stop();
      if (!discard.current) fail('contribute.guided.error.recording');
    }
  }

  function stop() {
    if (!recordingActive.current) return;
    userStopped.current = true;
    setPhase('saving');
    camera.current?.stopRecording();
  }

  function cancel() {
    if (recordingActive.current) { discard.current = true; camera.current?.stopRecording(); }
    onCancel();
  }

  const recording = phase === 'recording' || phase === 'saving';
  const notices = (phase === 'ready' ? ['contribute.guided.noLiveChecks']
    : recording ? [...lockNoticeKeys(lockReport(Platform.OS === 'ios' ? ['focus'] : [])), 'contribute.guided.noLiveChecks']
    : []).map((key) => t(key));

  return <View className="flex-1 bg-background">
    {permission === 'granted' && accepted && <CameraView
      ref={camera}
      style={StyleSheet.absoluteFill}
      facing="back"
      mode="video"
      mute
      videoQuality={budget.resolution}
      videoBitrate={budget.bitsPerSecond}
      // Electronic stabilisation warps each frame differently, which breaks
      // the single-camera model reconstruction solves for.
      videoStabilizationMode="off"
      // iOS: `on` focuses once and holds. Switched on at Start so it focuses
      // on the street, not on whatever was in front of the lens at launch.
      autofocus={recording ? 'on' : 'off'}
      responsiveOrientationWhenOrientationLocked
      onResponsiveOrientationChanged={({ orientation: next }) => setOrientation(next)}
      onCameraReady={() => setPhase((current) => (current === 'starting' ? 'ready' : current))}
      onMountError={() => fail('contribute.guided.error.camera')}
    />}
    <Upright orientation={orientation}>
      <GuidedOverlay
        phase={accepted ? phase : 'error'}
        session={session}
        budget={budget}
        portrait={orientation === 'portrait' || orientation === 'portraitUpsideDown'}
        notices={notices}
        error={accepted ? error : t('contribute.guided.error.format')}
        onStart={() => void start()}
        onStop={stop}
        onCancel={cancel}
      />
    </Upright>
  </View>;
}
