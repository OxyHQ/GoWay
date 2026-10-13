/**
 * The map's style button — the layers icon in the screen's top-right stack,
 * under the settings gear — and the picker it opens (`MapStylePicker.tsx`,
 * `docs/MAP_STYLES.md`).
 *
 * The picker loads with the settings modal's lazy chunk on the first press;
 * the first paint carries this button and its name and nothing else. Once
 * loaded it stays mounted, so it animates closed and open again as Bloom's
 * dialog does. The screen owns `open`, so Settings → Map → Style can open the
 * same picker.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { localizedLabel } from '@goway.to/sdk';
import { Fab } from '@oxy.so/bloom/fab';
import { RiStackLine } from '@oxy.so/bloom/icons/RiStackLine';

import { useTranslation } from '@/lib/i18n';
import { MAP_STYLE_TRIGGER_LABEL } from '@/lib/map/mapStyleTriggerLabel';

const MapStylePicker = lazy(() =>
  import('./MapSettingsModal').then((chunk) => ({ default: chunk.MapStylePicker })),
);

export interface MapStyleButtonProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A phone: the smaller round control, like the rest of its stack. */
  compact?: boolean;
}

export function MapStyleButton({ open, onOpenChange, compact = false }: MapStyleButtonProps) {
  const { locale } = useTranslation();
  // Requested on the first open, then kept.
  const [loaded, setLoaded] = useState(open);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  const label = localizedLabel(MAP_STYLE_TRIGGER_LABEL, locale);

  return (
    <>
      <Fab
        size={compact ? 'xs' : 'sm'}
        icon={RiStackLine}
        iconSize={compact ? 20 : 22}
        accessibilityLabel={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPress={() => onOpenChange(!open)}
        appearance={open ? 'solid' : 'subtle'}
        tone={open ? 'accent' : 'neutral'}
        testID="map-style-button"
      />
      {loaded ? (
        <Suspense fallback={null}>
          <MapStylePicker open={open} onClose={() => onOpenChange(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
