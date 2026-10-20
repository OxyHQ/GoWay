/**
 * "Save to…": the list picker a Save opens.
 *
 * Every list is a row with a checkbox that says whether this place is in it;
 * pressing a row saves or removes the place in that one list at once, and the
 * row is disabled while its request is out so a double tap cannot race itself.
 * A new list can be made inline and the place is saved into it.
 *
 * A person with no default list sees a row for "Saved" anyway: it is the list
 * a first save lands in, and the server creates it on that save
 * (`PUT /lists/default`), not before. A person who has not saved anything has
 * no list rows to look at except that one and the inline form.
 *
 * Opened only for a signed-in person (`useSaveControl` runs it through the
 * auth gate), and mounted only while open, so no request is made for a picker
 * nobody opened.
 */
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { MAX_SAVED_LIST_NAME_LENGTH } from '@goway.to/sdk';
import type { PlaceId, SavedList } from '@goway.to/sdk';

import {
  useCreateList,
  useRemoveSavedItem,
  useSavedHold,
  useSavedLists,
  useSavePlace,
} from '@/lib/goway/saved';
import { useTranslation } from '@/lib/i18n';

import { savedFailureMessage } from './savedErrors';

export interface SavePlaceDialogProps {
  placeId: PlaceId;
  /** The place's name, for the dialog's description. */
  placeName: string;
  onClose: () => void;
}

/** The row that stands for a default list the server has not created yet. */
const VIRTUAL_DEFAULT = '__default__';

export function SavePlaceDialog({ placeId, placeName, onClose }: SavePlaceDialogProps) {
  const { t } = useTranslation();
  const lists = useSavedLists(true);
  const hold = useSavedHold(placeId, true);
  const save = useSavePlace();
  const remove = useRemoveSavedItem();
  const create = useCreateList();

  const [name, setName] = useState('');
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const itemOf = useMemo(
    () => new Map((hold.data?.lists ?? []).map((entry) => [entry.listId, entry.itemId])),
    [hold.data],
  );

  const rows = useMemo<{ id: string; label: string; list: SavedList | null }[]>(() => {
    const real = (lists.data ?? []).map((list) => ({ id: list.id, label: list.name, list }));
    const hasDefault = (lists.data ?? []).some((list) => list.isDefault);
    return hasDefault || lists.isPending
      ? real
      : [{ id: VIRTUAL_DEFAULT, label: t('saved.defaultName'), list: null }, ...real];
  }, [lists.data, lists.isPending, t]);

  const toggle = useCallback(
    (row: { id: string; list: SavedList | null }, next: boolean) => {
      setFailure(null);
      setBusyRow(row.id);
      const done = {
        onSettled: () => setBusyRow(null),
        onError: (e: Error) => setFailure(savedFailureMessage(e, t)),
      };
      if (next) {
        save.mutate(
          {
            placeId,
            defaultName: t('saved.defaultName'),
            ...(row.list ? { listId: row.list.id } : {}),
          },
          done,
        );
        return;
      }
      const itemId = itemOf.get(row.id);
      if (itemId === undefined) {
        setBusyRow(null);
        return;
      }
      remove.mutate({ listId: row.id, itemId }, done);
    },
    [itemOf, placeId, remove, save, t],
  );

  const createAndSave = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setFailure(null);
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (list) => {
          setName('');
          save.mutate(
            { placeId, listId: list.id, defaultName: t('saved.defaultName') },
            { onError: (e) => setFailure(savedFailureMessage(e, t)) },
          );
        },
        onError: (e) => setFailure(savedFailureMessage(e, t)),
      },
    );
  }, [create, name, placeId, save, t]);

  const working = create.isPending || save.isPending || remove.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('saved.picker.title')}
      description={placeName}
      placement={{ base: 'bottom', md: 'center' }}
      testID="save-place-dialog"
    >
      <View className="gap-space-12">
        {lists.isError || hold.isError ? (
          <Text className="text-bodySmall text-destructive" accessibilityRole="alert">
            {t('saved.retry.message')}
          </Text>
        ) : null}

        <View className="gap-space-4" accessibilityRole="list">
          {rows.map((row) => {
            const checked = row.list ? itemOf.has(row.id) : false;
            return (
              <Checkbox
                key={row.id}
                label={row.label}
                checked={checked}
                disabled={busyRow !== null || hold.isPending}
                onCheckedChange={(next) => toggle(row, next)}
                accessibilityLabel={
                  checked
                    ? t('saved.picker.inList', { name: row.label })
                    : t('saved.picker.notInList', { name: row.label })
                }
                testID={`save-place-list-${row.id}`}
              />
            );
          })}
        </View>

        <View className="gap-space-8">
          <TextField size="sm">
            <TextFieldInput
              label={t('saved.list.nameLabel')}
              placeholder={t('saved.list.namePlaceholder')}
              value={name}
              onChangeText={setName}
              maxLength={MAX_SAVED_LIST_NAME_LENGTH}
              onSubmitEditing={createAndSave}
              returnKeyType="done"
              disabled={working}
            />
          </TextField>
          <View className="flex-row">
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              leadingIcon={RiAddLine}
              disabled={name.trim() === '' || working}
              onPress={createAndSave}
            >
              {t('saved.list.new')}
            </Button>
          </View>
        </View>

        {failure ? (
          <Text className="text-bodySmall text-destructive" accessibilityRole="alert">
            {failure}
          </Text>
        ) : null}

        <View className="flex-row justify-end">
          <Button size="sm" tone="accent" appearance="solid" onPress={onClose}>
            {t('saved.picker.done')}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
