/**
 * The time-of-day control: a sun in the explore screen's top-right stack,
 * shown only while the city sky draws, that opens the scrubber and — pressed
 * again — closes it, back to now (`docs/MAP_FEATURES.md` → "The time of
 * day"). A disclosure button: it announces whether the scrubber is open, and
 * the screen returns focus to it when the scrubber closes
 * ({@link focusTimeOfDayButton}).
 *
 * In the first paint with the rest of the stack, so it carries only its name
 * (`lib/map/timeOfDayTriggerLabel.ts`); the scrubber itself is a lazy chunk.
 */
import { localizedLabel } from '@goway.to/sdk';
import { Fab } from '@oxy.so/bloom/fab';
import { RiSunLine } from '@oxy.so/bloom/icons/RiSunLine';

import { useTranslation } from '@/lib/i18n';
import { TIME_OF_DAY_TRIGGER_LABEL } from '@/lib/map/timeOfDayTriggerLabel';

const BUTTON_ID = 'goway-time-of-day-toggle';

export function TimeOfDayButton({
  open,
  onToggle,
  compact = false,
}: {
  open: boolean;
  onToggle: () => void;
  /** A phone: the smaller round control, like the rest of its stack. */
  compact?: boolean;
}) {
  const { locale } = useTranslation();
  return (
    <Fab
      size={compact ? 'xs' : 'sm'}
      icon={RiSunLine}
      iconSize={compact ? 20 : 22}
      id={BUTTON_ID}
      accessibilityLabel={localizedLabel(TIME_OF_DAY_TRIGGER_LABEL, locale)}
      aria-expanded={open}
      onPress={onToggle}
      appearance={open ? 'solid' : 'subtle'}
      tone={open ? 'accent' : 'neutral'}
      testID="map-time-of-day-toggle"
    />
  );
}

/** Back to the control once the scrubber closes (web; native has no focus to move). */
export function focusTimeOfDayButton(): void {
  if (typeof document === 'undefined') return;
  const button = document.getElementById(BUTTON_ID);
  if (button instanceof HTMLElement) button.focus({ preventScroll: true });
}
