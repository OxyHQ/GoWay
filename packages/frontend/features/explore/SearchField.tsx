/**
 * The map-first search entry point.
 *
 * Bloom's `Search` already IS the pill text field with a leading magnifier and
 * a clear button, so this adds only what is specific to a map: the "searching"
 * indicator, a back affordance for leaving a result, and the accessible naming
 * that turns a bare input into something a screen-reader user can act on.
 */
import { forwardRef } from 'react';
import { View, type TextInput } from 'react-native';
import { Search } from '@oxy.so/bloom/search';
import { GlyphButton } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';

export interface SearchFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  onClear: () => void;
  onSubmit?: () => void;
  /** Shows a spinner in place of nothing while a query is in flight. */
  busy?: boolean;
  /** Renders a back button before the field. Present once something is open. */
  onBack?: () => void;
  backLabel?: string;
  placeholder?: string;
  testID?: string;
}

export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField(
  { value, onChangeText, onClear, onSubmit, busy = false, onBack, backLabel = 'Back to results', placeholder = 'Search places and addresses', testID },
  ref,
) {
  return (
    <View className="flex-row items-center gap-space-8 px-space-16 py-space-8">
      {onBack ? (
        <GlyphButton icon={RiArrowLeftLine} accessibilityLabel={backLabel} onPress={onBack} size={36} />
      ) : null}
      <View className="flex-1">
        <Search
          ref={ref}
          label={placeholder}
          value={value}
          onChangeText={onChangeText}
          onClearText={onClear}
          onSubmitEditing={onSubmit}
          testID={testID}
        />
      </View>
      {busy ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Searching">
          <Loading variant="spinner" size="small" />
        </View>
      ) : null}
    </View>
  );
});
