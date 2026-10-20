/**
 * `https://goway.to/saved/<listId>` — one saved list.
 *
 * The places are drawn by Bloom's `PlaceList`: the same `PlaceCard` row a
 * search result is (`placeRowCardProps`), the person's note under it, and the
 * controls that move a place earlier or later and remove it. Pressing a place
 * opens its note (and the way to the map). Renaming and deleting the list are
 * in the header.
 *
 * The list holds place ids and notes; each place is read with `places.getMany`,
 * so it is as fresh as the place. A place that is no longer on GoWay is shown
 * as exactly that, with the same remove control, instead of vanishing: the
 * person's list is theirs and does not lose a row because a place was
 * withdrawn.
 *
 * A list that is not the person's (or was deleted elsewhere) is the same
 * "not in your account" answer for both: the API does not tell them apart.
 */
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { placeDisplayName, GoWayNotFoundError } from '@goway.to/sdk';
import type { SavedListItem } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { PlaceList, type PlaceListPlace } from '@oxy.so/bloom/place-list';
import { Text } from '@oxy.so/bloom/typography';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';

import { useAuthGate } from '@/lib/authGate';
import {
  useDeleteList,
  useOrderSavedItems,
  useRemoveSavedItem,
  useRenameList,
  useSavedList,
  useSavedListItems,
  useSavedListPlaces,
} from '@/lib/goway/saved';
import { useCategoryTaxonomy } from '@/lib/goway/queries';
import { useTranslation } from '@/lib/i18n';

import { PanelState } from '../explore/states';
import { placeRowCardProps } from '../explore/ResultRows';
import { ListNameDialog } from './ListNameDialog';
import { SavedItemDialog } from './SavedItemDialog';

export function SavedListScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const params = useLocalSearchParams<{ listId?: string | string[] }>();
  const listId = (Array.isArray(params.listId) ? params.listId[0] : params.listId) ?? null;

  const list = useSavedList(listId, gate.canUsePrivateApi);
  const items = useSavedListItems(listId, gate.canUsePrivateApi);
  const taxonomy = useCategoryTaxonomy();
  const rename = useRenameList();
  const remove = useDeleteList();
  const removeItem = useRemoveSavedItem();
  const order = useOrderSavedItems();

  const placeIds = useMemo(() => (items.data ?? []).map((item) => item.placeId), [items.data]);
  const places = useSavedListPlaces(placeIds);

  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState<SavedListItem | null>(null);

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/saved');
  }, [router]);

  const showOnMap = useCallback(
    (placeId: string) => router.push(`/place/${encodeURIComponent(placeId)}`),
    [router],
  );

  const entries = useMemo<PlaceListPlace[]>(
    () =>
      (items.data ?? []).flatMap((item) => {
        const place = places.places.get(item.placeId);
        // Still being read: leave the row out until its place arrives, rather than flash a blank card.
        if (!place && !places.unavailable.has(item.placeId)) return [];
        return [
          {
            id: item.id,
            note: item.note,
            place: place
              ? { ...placeRowCardProps(place, taxonomy, t), onPress: () => setEditing(item) }
              : { name: t('saved.unavailable'), onPress: () => setEditing(item) },
          },
        ];
      }),
    [items.data, places.places, places.unavailable, taxonomy, t],
  );

  const onReorder = useCallback(
    (next: PlaceListPlace[]) => {
      if (listId === null) return;
      order.mutate({ listId, itemIds: next.map((entry) => entry.id) });
    },
    [listId, order],
  );

  const onRemove = useCallback(
    (itemId: string) => {
      if (listId !== null) removeItem.mutate({ listId, itemId });
    },
    [listId, removeItem],
  );

  const title = list.data?.name ?? t('saved.title');
  const editingPlace = editing ? places.places.get(editing.placeId) : undefined;

  let body: ReactNode;
  if (gate.isPending) {
    body = <Text className="text-muted-foreground">{t('saved.loading')}</Text>;
  } else if (!gate.canUsePrivateApi) {
    body = (
      <PanelState
        icon={RiLockLine}
        title={t('saved.signedOut.title')}
        body={t('saved.signedOut.body')}
        actionLabel={t('saved.signedOut.button')}
        actionIcon={RiBookmarkLine}
        onAction={() => gate.run(() => undefined)}
        testID="saved-signed-out"
      />
    );
  } else if (list.error instanceof GoWayNotFoundError) {
    body = (
      <PanelState
        icon={RiBookmarkLine}
        title={t('saved.list.notFound')}
        actionLabel={t('saved.back')}
        onAction={() => router.replace('/saved')}
        testID="saved-list-not-found"
      />
    );
  } else if (list.isError || items.isError || places.isError) {
    body = (
      <PanelState
        icon={RiErrorWarningLine}
        title={t('saved.retry.message')}
        actionLabel={t('saved.retry.button')}
        onAction={() => {
          void list.refetch();
          void items.refetch();
          places.refetch();
        }}
        testID="saved-error"
      />
    );
  } else if (list.isPending || items.isPending || places.isPending) {
    body = (
      <Text className="text-muted-foreground" accessibilityLiveRegion="polite">
        {t('saved.loading')}
      </Text>
    );
  } else {
    body = (
      <PlaceList
        places={entries}
        onReorder={onReorder}
        onRemove={onRemove}
        disabled={removeItem.isPending}
        accessibilityLabel={t('saved.list.accessibility', { name: title })}
        empty={
          <PanelState
            icon={RiBookmarkLine}
            title={t('saved.list.empty.title')}
            body={t('saved.list.empty.body')}
            testID="saved-list-empty"
          />
        }
        testID="saved-place-list"
      />
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-space-16 p-space-20">
        <Button appearance="plain" tone="neutral" onPress={back}>
          {t('saved.title')}
        </Button>
        <Text variant="title-1-bold" accessibilityRole="header">
          {title}
        </Text>
        {list.data ? (
          <View className="flex-row flex-wrap gap-space-8">
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              leadingIcon={RiEditLine}
              onPress={() => setRenaming(true)}
            >
              {t('saved.list.rename')}
            </Button>
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              leadingIcon={RiDeleteBinLine}
              onPress={() => setConfirmingDelete(true)}
            >
              {t('saved.list.delete')}
            </Button>
          </View>
        ) : null}

        {body}
      </ScrollView>

      {renaming && list.data && listId !== null ? (
        <ListNameDialog
          title={t('saved.list.renameTitle')}
          confirmLabel={t('saved.list.save')}
          initialName={list.data.name}
          onSubmit={(name) => rename.mutateAsync({ listId, name })}
          onClose={() => setRenaming(false)}
        />
      ) : null}

      {confirmingDelete && list.data && listId !== null ? (
        <Dialog
          open
          onClose={() => setConfirmingDelete(false)}
          title={t('saved.list.deleteTitle', { name: list.data.name })}
          description={t('saved.list.deleteBody')}
          placement={{ base: 'bottom', md: 'center' }}
          actions={[
            { label: t('saved.list.cancel'), color: 'cancel' },
            {
              label: t('saved.list.delete'),
              color: 'destructive',
              onPress: () =>
                remove.mutate({ listId }, { onSuccess: () => router.replace('/saved') }),
            },
          ]}
          testID="delete-list-dialog"
        />
      ) : null}

      {editing ? (
        <SavedItemDialog
          item={items.data?.find((item) => item.id === editing.id) ?? editing}
          placeName={editingPlace ? placeDisplayName(editingPlace) : t('saved.unavailable')}
          {...(editingPlace
            ? {
                onShowOnMap: () => {
                  setEditing(null);
                  showOnMap(editing.placeId);
                },
              }
            : {})}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}
