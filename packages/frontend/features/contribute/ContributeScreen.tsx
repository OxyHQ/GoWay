import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { randomUUID } from 'expo-crypto';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services';
import type { CaptureAsset, CaptureAssetInput, CaptureSession, CaptureUploadPolicy, CaptureUploadTicket } from '@goway.to/sdk';
import { MapCanvas, type MapApi } from '@/components/map';
import { useAuthGate } from '@/lib/authGate';
import { useTranslation } from '@/lib/i18n';
import { captureClient } from './client';
import { CaptureGuide } from './CaptureGuide';
import { ContributionStatusCard } from './ContributionStatusCard';
import { GuidedCapture, type GuidedRecording } from './guided/GuidedCapture';
import { formatClock } from './guided/plan';
import { hashMedia, releaseMedia, selectMedia, uploadMedia } from './media';
import { mediaLocation, type SelectedMedia } from './media.shared';

export function ContributeScreen() {
  const router = useRouter();
  const gate = useAuthGate();
  const { t } = useTranslation();
  const { user } = useOxy();
  const [policy, setPolicy] = useState<CaptureUploadPolicy | null>(null);
  const [media, setMedia] = useState<SelectedMedia | null>(null);
  const [location, setLocation] = useState<CaptureAssetInput['location'][number] | null>(null);
  const [source, setSource] = useState<CaptureSession['source']>('library');
  const [guided, setGuided] = useState(false);
  /** What a guided recording knows that a picked file's metadata would otherwise carry. */
  const [capture, setCapture] = useState<{ capturedAt: string; frameRate?: number } | null>(null);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [assets, setAssets] = useState<CaptureAsset[]>([]);
  const map = useRef<MapApi | null>(null);
  const active = useRef<AbortController | null>(null);
  const pending = useRef<{ sessionId: string; input: CaptureAssetInput; ticket?: CaptureUploadTicket } | null>(null);
  const currentUser = useRef(user?.id);
  currentUser.current = user?.id;
  // Bumped whenever the media in hand changes, so a location fix asked for at
  // the start of one guided capture can never attach to a different file.
  const captureRun = useRef(0);

  const refresh = useCallback(async () => {
    if (!gate.canUsePrivateApi) return;
    const account = user?.id;
    const result = await captureClient.sessions();
    if (currentUser.current === account) setSessions(result);
  }, [gate.canUsePrivateApi, user?.id]);

  // The policy is answered FOR THE CALLER (a closed pilot admits named
  // accounts only), so it is fetched again whenever the session changes: an
  // answer fetched before sign-in finished is the anonymous one.
  useEffect(() => {
    let mounted = true;
    captureClient.policy().then((value) => { if (mounted) setPolicy(value); })
      .catch(() => { if (mounted) setError('Contribution is temporarily unavailable. Please try again later.'); });
    return () => { mounted = false; };
  }, [gate.canUsePrivateApi, user?.id]);
  useEffect(() => () => active.current?.abort(), []);
  // A guided recording on web is held through an object URL; let it go with the media.
  useEffect(() => () => { if (media) releaseMedia(media.asset); }, [media]);
  useEffect(() => {
    active.current?.abort(); pending.current = null; captureRun.current += 1; setSessions([]); setAssets([]); setConsent(false); setMedia(null); setLocation(null); setCapture(null); setGuided(false); setStatus(''); setError(''); setBusy(false);
    if (gate.canUsePrivateApi) void refresh().catch(() => setError('Could not load your contributions.'));
  }, [gate.canUsePrivateApi, user?.id, refresh]);

  async function pick(camera: boolean, video = false) {
    if (!policy || busy || !gate.canUsePrivateApi) return;
    const account = user?.id;
    setError('');
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('Camera permission is needed only to take this contribution.');
      const result = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: video ? ['videos'] : ['images'], exif: true, quality: 1, videoMaxDuration: policy.video.maxDurationSeconds })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], exif: true, quality: 1 });
      if (result.canceled || !result.assets[0]) return;
      const selected = await selectMedia(result.assets[0], policy);
      if (currentUser.current !== account) return;
      captureRun.current += 1;
      pending.current = null; setMedia(selected); setSource(camera ? 'camera' : 'library'); setCapture(null); setStatus('');
      const evidence = mediaLocation(selected.asset);
      setLocation(evidence);
      if (evidence) map.current?.moveTo(evidence.coordinate, { zoom: 17 });
    } catch (e) { setError(e instanceof Error ? e.message : 'The media could not be selected.'); }
  }

  function openGuided() {
    if (!policy || busy || !gate.canUsePrivateApi) return;
    captureRun.current += 1;
    pending.current = null; setMedia(null); setLocation(null); setCapture(null); setError(''); setStatus('');
    setGuided(true);
  }

  /**
   * The user pressed Start in the guided camera: they are standing where the
   * recording begins, so this — and only this — asks for location, once. A
   * refusal is fine: the capture is placed on the map instead.
   */
  function guidedStarted() {
    const account = user?.id;
    const run = captureRun.current;
    void (async () => {
      try {
        if (!(await Location.requestForegroundPermissionsAsync()).granted) return;
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        if (currentUser.current !== account || captureRun.current !== run) return;
        const coordinate = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        setLocation((current) => current ?? {
          origin: 'device_capture', coordinate, accuracyMeters: position.coords.accuracy ?? undefined, observedAt: new Date(position.timestamp).toISOString(),
        });
        map.current?.moveTo(coordinate, { zoom: 17 });
      } catch { /* Placed on the map instead. */ }
    })();
  }

  async function guidedRecorded(recording: GuidedRecording) {
    setGuided(false);
    if (!policy) { releaseMedia(recording.asset); return; }
    const account = user?.id;
    const seconds = (recording.asset.duration ?? 0) / 1000;
    try {
      const selected = await selectMedia(recording.asset, policy);
      if (currentUser.current !== account) { releaseMedia(recording.asset); return; }
      pending.current = null; setMedia(selected); setSource('guided_session');
      setCapture({ capturedAt: recording.capturedAt, ...(recording.frameRate ? { frameRate: recording.frameRate } : {}) });
      const time = formatClock(seconds);
      const summary = recording.blurryFraction === undefined ? t('contribute.guided.summary', { time })
        : recording.blurryFraction >= 0.1 ? t('contribute.guided.summaryBlur', { time, percent: Math.round(recording.blurryFraction * 100) })
        : t('contribute.guided.summarySharp', { time });
      setStatus(recording.stoppedAtLimit ? `${summary} ${t('contribute.guided.limitReached')}` : summary);
    } catch (e) {
      releaseMedia(recording.asset);
      const tooLarge = (recording.asset.fileSize ?? 0) > policy.video.maxByteSize || seconds > policy.video.maxDurationSeconds;
      setError(tooLarge
        ? t('contribute.guided.tooLarge', { megabytes: Math.floor(policy.video.maxByteSize / 1048576), minutes: Math.floor(policy.video.maxDurationSeconds / 60) })
        : e instanceof Error ? e.message : t('contribute.guided.error.recording'));
    }
  }

  async function locate() {
    const account = user?.id;
    setError('');
    try {
      if (!(await Location.requestForegroundPermissionsAsync()).granted) throw new Error('Choose the capture location on the map instead.');
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (currentUser.current !== account) return;
      const coordinate = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setLocation({ origin: 'user_placed', coordinate, accuracyMeters: position.coords.accuracy ?? undefined });
      map.current?.moveTo(coordinate, { zoom: 17 });
    } catch { setError('Your location is unavailable. You can still select the capture location on the map.'); }
  }

  async function submit() {
    if (!gate.canUsePrivateApi || !media || !location || !policy || !consent || busy) return;
    const account = user?.id;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError('');
    try {
      if (!pending.current) {
        setStatus('Checking the selected file…');
        const contentHash = await hashMedia(media, controller.signal);
        const session = await captureClient.createSession({ source, consentVersion: policy.consentVersion }, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (currentUser.current !== account) return;
        pending.current = { sessionId: session.id, input: {
          idempotencyKey: randomUUID(), mediaKind: media.kind, source, contentHash,
          byteSize: media.byteSize, contentType: media.contentType, location: [location],
          ...(capture ? { capturedAt: capture.capturedAt } : {}),
          camera: { ...(media.asset.width > 0 ? { widthPixels: media.asset.width } : {}), ...(media.asset.height > 0 ? { heightPixels: media.asset.height } : {}),
            ...(media.asset.duration ? { durationSeconds: media.asset.duration / 1000 } : {}), ...(capture?.frameRate ? { frameRate: capture.frameRate } : {}) },
        } };
      }
      const request = pending.current;
      const ticket = await captureClient.register(request.sessionId, request.input, { signal: controller.signal });
      request.ticket = ticket;
      if (ticket.upload) {
        setStatus('Uploading directly to secure storage…');
        await uploadMedia(media, ticket.upload, controller.signal);
      }
      setStatus('Confirming the upload…');
      const asset = await captureClient.finalize(ticket.asset.id, { signal: controller.signal });
      if (currentUser.current !== account) return;
      setAssets([asset]); pending.current = null; setMedia(null); setCapture(null); setStatus('Contribution received. Privacy processing must finish before reconstruction.');
      await refresh();
    } catch {
      if (currentUser.current === account) setError(controller.signal.aborted ? 'Upload cancelled. You can retry or withdraw the pending contribution below.' : 'The contribution could not finish. Retry to resume the same upload.');
    } finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  async function withdraw(asset: CaptureAsset) {
    if (!gate.canUsePrivateApi || busy) return;
    const account = user?.id;
    setError('');
    try {
      const removed = await captureClient.remove(asset.id);
      if (currentUser.current !== account) return;
      setAssets((current) => current.map((item) => item.id === removed.id ? removed : item));
      if (pending.current?.ticket?.asset.id === asset.id) pending.current = null;
    } catch { setError('The contribution could not be withdrawn. Please try again.'); }
  }

  if (guided && policy) {
    return <View className="flex-1 bg-background">
      <GuidedCapture policy={policy} onStart={guidedStarted} onRecorded={(recording) => void guidedRecorded(recording)} onCancel={() => setGuided(false)} />
    </View>;
  }

  return <SafeAreaView className="flex-1 bg-background">
    <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-space-16 p-space-20">
      <Button appearance="plain" tone="neutral" onPress={() => router.back()}>Back to map</Button>
      <Text variant="title-1-bold">Contribute to Street 3D</Text>
      <Text>Help build a community 3D view with ordinary photos and videos. Complementary viewpoints are more useful than repeated copies.</Text>
      <CaptureGuide />
      {!gate.canUsePrivateApi && <Button onPress={() => gate.run(() => {})}>Sign in to contribute</Button>}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {!policy && !error && <ActivityIndicator accessibilityLabel="Loading contribution policy" />}
      {policy?.enabled === false && <Text>Contributions are not enabled here yet. You can keep using the map.</Text>}
      {policy && policy.enabled !== false && <>
        <View className="flex-row flex-wrap gap-space-8">
          <Button disabled={busy || !gate.canUsePrivateApi} onPress={() => void pick(false)}>Choose photo or video</Button>
          <Button disabled={busy || !gate.canUsePrivateApi} appearance="outline" onPress={() => void pick(true)}>Take photo</Button>
          <Button disabled={busy || !gate.canUsePrivateApi} appearance="outline" onPress={() => void pick(true, true)}>Record video</Button>
          <Button disabled={busy || !gate.canUsePrivateApi} appearance="outline" onPress={openGuided}>{t('contribute.guided.button')}</Button>
        </View>
        {media && <>
          {media.kind === 'photo' && <Image source={{ uri: media.asset.uri }} style={{ height: 180, width: '100%' }} contentFit="contain" accessibilityLabel="Selected contribution preview" />}
          <Text>{media.asset.fileName ?? (media.kind === 'video' ? 'Selected video' : 'Selected photo')} · {(media.byteSize / 1048576).toFixed(1)} MB</Text>
          <Text variant="body-semibold">Where was this captured?</Text>
          <Text>{location ? 'Location selected. Tap the map to correct it.' : 'Select the capture location on the map. We never infer it from your history.'}</Text>
          <View className="h-64 overflow-hidden rounded-radius-lg">
            <MapCanvas initialViewport={location ? { ...location.coordinate, zoom: 16 } : undefined}
              ref={map}
              onPress={(event) => { if (!busy && !pending.current) setLocation({ origin: 'user_placed', coordinate: event.coordinate }); }}
              markers={location ? [{ id: 'capture', coordinate: location.coordinate, label: 'Capture location' }] : []} />
          </View>
          <Button appearance="outline" disabled={busy || !!pending.current} onPress={() => void locate()}>Use my current location</Button>
          <Text>Original photos are kept for up to about {policy.retentionDays.raw_photo} days and original videos for up to about {policy.retentionDays.raw_video} days, often less. Not every contribution becomes a scene.</Text>
          <Text>GoWay may create privacy-processed images, features and 3D assets. Your account is linked to your contribution for consent and removal. Published non-personal geometry may remain after originals expire. We do not capture in the background.</Text>
          <Checkbox checked={consent} disabled={busy} onCheckedChange={setConsent} label="I have the right to share this media and agree to its use for community 3D reconstruction." />
          <Button disabled={!consent || !location || busy || !gate.canUsePrivateApi} onPress={() => void submit()}>{pending.current ? 'Retry contribution' : 'Contribute'}</Button>
          {busy && <Button appearance="outline" onPress={() => active.current?.abort()}>Cancel upload</Button>}
        </>}
      </>}
      {status ? <Text accessibilityLiveRegion="polite">{status}</Text> : null}
      {busy && <ActivityIndicator accessibilityLabel={status} />}
      {gate.canUsePrivateApi && <>
        <Text variant="body-semibold">Your recent contributions</Text>
        <Button appearance="plain" onPress={() => void refresh().catch(() => setError('Could not refresh contributions.'))}>Refresh</Button>
        {sessions.map((session) => <Button key={session.id} appearance="outline" onPress={() => {
          const account = user?.id;
          void captureClient.assets(session.id).then((items) => { if (currentUser.current === account) setAssets(items); })
            .catch(() => setError('Could not load this contribution.'));
        }}>{new Date(session.createdAt).toLocaleDateString()} · {session.assetCount} item(s)</Button>)}
        {assets.map((asset) => <ContributionStatusCard key={asset.id} asset={asset} busy={busy} onWithdraw={(item) => void withdraw(item)} />)}
      </>}
    </ScrollView>
  </SafeAreaView>;
}
