/**
 * The map's layers button, and the panel it opens — GoWay's version of Apple
 * Maps' map options: how the map is seen (2D or 3D), which layers it draws,
 * and, once revealed, the Labs features (`docs/MAP_FEATURES.md`).
 *
 * Bloom's `Popover`: a panel beside the button on the web, a bottom sheet on
 * native. The panel's BODY (`MapLayersPanel.tsx`) and its copy in every label
 * language load on first open, so the first paint carries the button and
 * its name and nothing else.
 *
 * Labs is hidden until asked for: `?labs=1` on any goway.to address, once
 * (remembered on this device; `?labs=0` forgets), or by pressing and holding
 * this button. Revealing Labs switches nothing on — every Labs feature still
 * starts off until its own switch is turned.
 */
import { lazy, Suspense, useCallback, useState } from 'react';
import { View } from 'react-native';
import { localizedLabel } from '@goway.to/sdk';
import { Fab } from '@oxy.so/bloom/fab';
import { Loading } from '@oxy.so/bloom/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@oxy.so/bloom/popover';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';

import { useTranslation } from '@/lib/i18n';
import { MAP_LAYERS_TRIGGER_LABEL } from '@/lib/map/mapLayersTriggerLabel';
import { mapFeatureStore } from '@/lib/map/useMapFeatures';

const MapLayersPanel = lazy(() =>
  import('./MapLayersPanel').then((chunk) => ({ default: chunk.MapLayersPanel })),
);

/** The panel's width on the web, where it floats beside the button. */
const PANEL_WIDTH = 320;

export interface MapLayersButtonProps {
  /** Whether the camera is tilted — the 2D/3D control's value. */
  tilted: boolean;
  /** Tilt the camera to 3D, or level it to 2D. */
  onTiltChange: (tilted: boolean) => void;
}

export function MapLayersButton({ tilted, onTiltChange }: MapLayersButtonProps) {
  const { locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = localizedLabel(MAP_LAYERS_TRIGGER_LABEL, locale);

  // The hidden way in: hold the button. It opens the panel too, so the
  // section that just appeared is in front of the person who asked for it.
  const revealLabs = useCallback(() => {
    mapFeatureStore.setLabs(true);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Fab
          size="sm"
          icon={RiStackLine}
          iconSize={22}
          accessibilityLabel={label}
          onLongPress={revealLabs}
          appearance="subtle"
          tone="neutral"
          testID="map-layers"
        />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        label={label}
        minWidth={PANEL_WIDTH}
        maxWidth={PANEL_WIDTH}
        testID="map-layers-panel"
      >
        <Suspense
          fallback={
            <View className="items-center justify-center py-space-24">
              <Loading size="sm" />
            </View>
          }
        >
          <MapLayersPanel tilted={tilted} onTiltChange={onTiltChange} onClose={close} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
