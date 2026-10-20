/**
 * The map-first search entry point.
 *
 * Bloom's `Search` already IS the pill text field with a leading magnifier and
 * a clear button, so this adds only what is specific to a map: the "searching"
 * indicator, a back affordance for leaving a result, and the accessible naming
 * that turns a bare input into something a screen-reader user can act on.
 */
import { type ForwardRefExoticComponent, forwardRef, type RefAttributes } from 'react';
import { type TextInputInstance, View } from 'react-native';
import { Search } from '@oxy.so/bloom/search';
import { GlyphButton } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';

import { useTranslation } from '@/lib/i18n';

export interface SearchFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  onClear: () => void;
  onSubmit?: () => void;
  /** ArrowDown / ArrowUp, for moving through the results without leaving the field. */
  onNavigate?: (delta: 1 | -1) => void;
  /** Shows a spinner while a query is in flight. */
  busy?: boolean;
  /** Renders a back button before the field. Present once something is open. */
  onBack?: () => void;
  backLabel?: string;
  placeholder?: string;
  testID?: string;
}

export const SearchField: ForwardRefExoticComponent<
  SearchFieldProps & RefAttributes<TextInputInstance>
> = forwardRef<TextInputInstance, SearchFieldProps>(function SearchField(
  {
    value,
    onChangeText,
    onClear,
    onSubmit,
    onNavigate,
    busy = false,
    onBack,
    backLabel,
    placeholder,
    testID,
  },
  ref,
) {
  const { t } = useTranslation();
  const label = placeholder ?? t('search.placeholder');
  return (
    <View className="flex-row items-center gap-space-8 px-space-16 py-space-8">
      {onBack ? (
        <GlyphButton
          icon={RiArrowLeftLine}
          accessibilityLabel={backLabel ?? t('search.back.default')}
          onPress={onBack}
          size={36}
        />
      ) : null}
      <View className="flex-1">
        <Search
          ref={ref}
          label={label}
          value={value}
          onChangeText={onChangeText}
          onClearText={onClear}
          onSubmitEditing={onSubmit}
          // Escape is the web's way out of a search: first clear it, then leave the field.
          onKeyPress={(event) => {
            const { key } = event.nativeEvent;
            if (key === 'ArrowDown' || key === 'ArrowUp') {
              onNavigate?.(key === 'ArrowDown' ? 1 : -1);
              return;
            }
            if (key !== 'Escape') return;
            if (value.length > 0) onClear();
            else (event.target as { blur?: () => void } | null)?.blur?.();
          }}
          testID={testID}
        />
      </View>
      {/* The slot is always there, so the field does not jump when a search starts. */}
      <View className="h-5 w-5 items-center justify-center">
        {busy ? (
          <View accessibilityRole="progressbar" accessibilityLabel={t('search.searching')}>
            <Loading variant="spinner" size="sm" />
          </View>
        ) : null}
      </View>
    </View>
  );
});
