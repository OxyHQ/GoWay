/**
 * One saved place: the person's note about it, and the way back to the map.
 *
 * Opened by pressing the place in a list. The note is the person's own line
 * ("Get the sourdough before noon"): saved as typed, trimmed, cleared with
 * "Remove note". It lives on the list item, never on the place.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Textarea } from '@oxy.so/bloom/textarea';
import { Text } from '@oxy.so/bloom/typography';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { MAX_SAVED_ITEM_NOTE_LENGTH } from '@goway.to/sdk';
import type { SavedListItem } from '@goway.to/sdk';

import { useSetSavedNote } from '@/lib/goway/saved';
import { useTranslation } from '@/lib/i18n';

import { savedFailureMessage } from './savedErrors';

export interface SavedItemDialogProps {
  item: SavedListItem;
  /** The place's name, for the dialog's title. */
  placeName: string;
  /** Open the place on the map. Absent for a place that is no longer on GoWay. */
  onShowOnMap?: () => void;
  onClose: () => void;
}

export function SavedItemDialog({ item, placeName, onShowOnMap, onClose }: SavedItemDialogProps) {
  const { t } = useTranslation();
  const setNote = useSetSavedNote();
  const [note, setDraft] = useState(item.note ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const write = useCallback(
    (next: string | null) => {
      setFailure(null);
      setNote.mutate(
        { listId: item.listId, itemId: item.id, note: next },
        { onSuccess: onClose, onError: (error) => setFailure(savedFailureMessage(error, t)) },
      );
    },
    [item.id, item.listId, onClose, setNote, t],
  );

  const unchanged = note.trim() === (item.note ?? '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={placeName}
      placement={{ base: 'bottom', md: 'center' }}
      testID="saved-item-dialog"
    >
      <View className="gap-space-12">
        <Textarea
          label={t('saved.note.title')}
          placeholder={t('saved.note.placeholder')}
          value={note}
          onChangeText={setDraft}
          rows={3}
          maxLength={MAX_SAVED_ITEM_NOTE_LENGTH}
          editable={!setNote.isPending}
        />
        {failure ? (
          <Text className="text-bodySmall text-destructive" accessibilityRole="alert">
            {failure}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap justify-end gap-space-8">
          {onShowOnMap ? (
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              leadingIcon={RiMapPin2Line}
              onPress={onShowOnMap}
            >
              {t('saved.note.showOnMap')}
            </Button>
          ) : null}
          {item.note ? (
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              disabled={setNote.isPending}
              onPress={() => write(null)}
            >
              {t('saved.note.clear')}
            </Button>
          ) : null}
          <Button
            size="sm"
            tone="accent"
            appearance="solid"
            disabled={setNote.isPending || unchanged || note.trim() === ''}
            onPress={() => write(note.trim())}
          >
            {t('saved.note.save')}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
