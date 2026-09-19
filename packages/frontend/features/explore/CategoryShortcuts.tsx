/**
 * The one-tap category filters.
 *
 * Each chip is a saved QUERY, not a client-side predicate: pressing one changes
 * the `categories` filter the SDK sends, so it keeps working when the visible
 * set is a page of a much larger one. Selecting a second chip replaces the
 * first — a map with six overlapping category filters is a filter panel, and
 * that is a different feature.
 */
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { useTheme } from '@oxy.so/bloom/theme';

import { CATEGORY_SHORTCUTS } from '@/lib/goway/categories';

export interface CategoryShortcutsProps {
  /** The selected shortcut's id, or `null` for "everything". */
  selected: string | null;
  onSelect: (id: string | null) => void;
  testID?: string;
}

export function CategoryShortcuts({ selected, onSelect, testID }: CategoryShortcutsProps) {
  const theme = useTheme();

  return (
    <ChipRow
      role="radiogroup"
      accessibilityLabel="Filter places by category"
      contentInset={16}
      testID={testID}
    >
      {CATEGORY_SHORTCUTS.map((shortcut) => {
        const isSelected = selected === shortcut.id;
        const Icon = shortcut.icon;
        return (
          <Chip
            key={shortcut.id}
            role="radio"
            size="large"
            variant="inverted"
            selected={isSelected}
            // Pressing the selected chip clears the filter, which is the only
            // way back to "everything" without a seventh chip labelled "All".
            onPress={() => onSelect(isSelected ? null : shortcut.id)}
            startIcon={
              <Icon
                width={16}
                height={16}
                fill={isSelected ? theme.colors.primaryForeground : theme.colors.textSecondary}
              />
            }
            accessibilityLabel={shortcut.label}
          >
            {shortcut.label}
          </Chip>
        );
      })}
    </ChipRow>
  );
}
