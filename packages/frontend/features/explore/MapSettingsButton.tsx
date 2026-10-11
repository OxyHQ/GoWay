/**
 * The map's settings button — a gear at the top of the screen's top-right
 * stack — and the Bloom `Dialog` it opens (a side sheet on a wide window, a
 * bottom sheet on a phone and on native): the map view, the map's layers,
 * the app's general settings and the About section with every credit
 * (`MapSettingsPanel.tsx`, `docs/MAP_FEATURES.md`).
 *
 * The dialog's BODY and its copy in every label language load on first open,
 * so the first paint carries the button and its name and nothing else.
 *
 * Labs (the experimental layers) is hidden until asked for: `?labs=1` on any
 * goway.to address, once (remembered on this device; `?labs=0` forgets), or by
 * pressing and holding this button. Revealing Labs switches nothing on.
 */
import { lazy, Suspense, useCallback, useState } from 'react';
import { View } from 'react-native';
import { localizedLabel } from '@goway.to/sdk';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Fab } from '@oxy.so/bloom/fab';
import { Loading } from '@oxy.so/bloom/loading';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';

import { useTranslation } from '@/lib/i18n';
import { mapFeatureStore } from '@/lib/map/useMapFeatures';
import { MAP_SETTINGS_TRIGGER_LABEL } from '@/lib/map/mapSettingsTriggerLabel';

const MapSettingsPanel = lazy(() =>
  import('./MapSettingsPanel').then((chunk) => ({ default: chunk.MapSettingsPanel })),
);

/** A side sheet from a tablet up, a bottom sheet below that. */
const PLACEMENT = { base: 'bottom', md: 'right' } as const;

export interface MapSettingsButtonProps {
  /** Whether the camera is tilted — the 2D/3D control's value. */
  tilted: boolean;
  /** Tilt the camera to 3D, or level it to 2D. */
  onTiltChange: (tilted: boolean) => void;
}

export function MapSettingsButton({ tilted, onTiltChange }: MapSettingsButtonProps) {
  const { locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = localizedLabel(MAP_SETTINGS_TRIGGER_LABEL, locale);

  // The hidden way in to Labs: hold the button. It opens the dialog too, so
  // the section that just appeared is in front of the person who asked.
  const revealLabs = useCallback(() => {
    mapFeatureStore.setLabs(true);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Fab
        size="sm"
        icon={RiSettings3Line}
        iconSize={22}
        accessibilityLabel={label}
        aria-expanded={open}
        onPress={() => setOpen(true)}
        onLongPress={revealLabs}
        appearance="subtle"
        tone="neutral"
        testID="map-settings"
      />
      <Dialog
        open={open}
        onClose={close}
        title={label}
        placement={PLACEMENT}
        scrollable
        testID="map-settings-dialog"
      >
        {open ? (
          <Suspense
            fallback={
              <View className="items-center justify-center py-space-24">
                <Loading size="sm" />
              </View>
            }
          >
            <MapSettingsPanel tilted={tilted} onTiltChange={onTiltChange} onClose={close} />
          </Suspense>
        ) : null}
      </Dialog>
    </>
  );
}
