/**
 * The map's settings button — a gear at the top of the screen's top-right
 * stack — and Bloom's `SettingsModal` it opens (`MapSettingsModal.tsx`,
 * `docs/MAP_FEATURES.md`): a rail of pages on a wide window, the section list
 * and then the page on a phone, native included.
 *
 * The modal links Bloom's whole settings shell, so it is its own lazy chunk,
 * requested on the first press: the first paint carries the button and its
 * name and nothing else. Once loaded it stays mounted, so closing and opening
 * again animates as Bloom's modal does.
 *
 * Labs (the experimental features) is hidden until asked for: `?labs=1` on any
 * goway.to address, once (remembered on this device; `?labs=0` forgets), or by
 * pressing and holding this button — which opens the modal on the Labs page.
 * Revealing Labs switches nothing on.
 */
import { lazy, Suspense, useCallback, useState } from 'react';
import { localizedLabel } from '@goway.to/sdk';
import { Fab } from '@oxy.so/bloom/fab';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';

import { useTranslation } from '@/lib/i18n';
import type { MapSettingsPageId } from '@/lib/map/mapSettingsPages';
import { MAP_SETTINGS_TRIGGER_LABEL } from '@/lib/map/mapSettingsTriggerLabel';
import { mapFeatureStore } from '@/lib/map/useMapFeatures';

const MapSettingsModal = lazy(() =>
  import('./MapSettingsModal').then((chunk) => ({ default: chunk.MapSettingsModal })),
);

export interface MapSettingsButtonProps {
  /** Whether the camera is tilted — the 2D/3D control's value. */
  tilted: boolean;
  /** Tilt the camera to 3D, or level it to 2D. */
  onTiltChange: (tilted: boolean) => void;
  /**
   * Open the time-of-day scrubber — Settings → Map → "Change time…". Passed
   * only while the sky draws; absent, the row is not offered.
   */
  onChangeTime?: () => void;
  /** A phone: the smaller round control, like the rest of its stack. */
  compact?: boolean;
}

export function MapSettingsButton({
  tilted,
  onTiltChange,
  onChangeTime,
  compact = false,
}: MapSettingsButtonProps) {
  const { locale } = useTranslation();
  const [open, setOpen] = useState(false);
  // Requested on the first press, then kept: the chunk is never fetched for
  // somebody who never opens settings.
  const [loaded, setLoaded] = useState(false);
  const [initialPage, setInitialPage] = useState<MapSettingsPageId | undefined>(undefined);
  const label = localizedLabel(MAP_SETTINGS_TRIGGER_LABEL, locale);

  const show = useCallback((page?: MapSettingsPageId) => {
    setInitialPage(page);
    setLoaded(true);
    setOpen(true);
  }, []);
  // The hidden way in to Labs: hold the button. It opens the modal on the
  // Labs page, so the section that just appeared is in front of the person.
  const revealLabs = useCallback(() => {
    mapFeatureStore.setLabs(true);
    show('labs');
  }, [show]);
  const close = useCallback(() => setOpen(false), []);
  // The scrubber is on the map, so the modal steps out of its way first.
  const changeTime = useCallback(() => {
    setOpen(false);
    onChangeTime?.();
  }, [onChangeTime]);

  return (
    <>
      <Fab
        size={compact ? 'xs' : 'sm'}
        icon={RiSettings3Line}
        iconSize={compact ? 20 : 22}
        accessibilityLabel={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPress={() => show()}
        onLongPress={revealLabs}
        appearance="subtle"
        tone="neutral"
        testID="map-settings"
      />
      {loaded ? (
        <Suspense fallback={null}>
          <MapSettingsModal
            open={open}
            onClose={close}
            initialPage={initialPage}
            tilted={tilted}
            onTiltChange={onTiltChange}
            onChangeTime={onChangeTime ? changeTime : undefined}
          />
        </Suspense>
      ) : null}
    </>
  );
}
