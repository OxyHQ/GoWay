/**
 * `https://goway.to/saved` — the person's saved lists.
 *
 * Personal, so identity-bound: signed out, the screen says what it is for and
 * offers the Oxy sign-in (`useAuthGate`) and makes no request. Signed in, it
 * lists every list with Bloom's `PlaceListCard` — name, how many places, and a
 * cover from the first places' photos — and opens one on press. The covers are
 * the places' own photos, read with the places (`places.getMany`); nothing
 * about a place is stored with the list.
 *
 * Every list is private. The screen says so once, in words, rather than
 * decorating each card with a lock.
 */
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { PlaceListCard } from '@oxy.so/bloom/place-list';
import { Text } from '@oxy.so/bloom/typography';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';

import { useAuthGate } from '@/lib/authGate';
import { useCreateList, useSavedListPlaces, useSavedLists } from '@/lib/goway/saved';
import { useTranslation } from '@/lib/i18n';
import { pluralKey } from '@/lib/mercaria/presentation';

import { PanelState } from '../explore/states';
import { ListNameDialog } from './ListNameDialog';

export function SavedScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const lists = useSavedLists(gate.canUsePrivateApi);
  const create = useCreateList();
  const [naming, setNaming] = useState(false);

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const coverIds = useMemo(
    () => [...new Set((lists.data ?? []).flatMap((list) => list.coverPlaceIds))],
    [lists.data],
  );
  const covers = useSavedListPlaces(coverIds);

  const open = useCallback(
    (listId: string) => router.push(`/saved/${encodeURIComponent(listId)}`),
    [router],
  );

  const createList = useCallback(
    (name: string) =>
      create.mutateAsync({ name }).then((list) => {
        open(list.id);
        return list;
      }),
    [create, open],
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-space-16 p-space-20">
        <Button appearance="plain" tone="neutral" onPress={back}>
          {t('saved.back')}
        </Button>
        <View className="flex-row items-center justify-between gap-space-12">
          <Text variant="title-1-bold" accessibilityRole="header">
            {t('saved.title')}
          </Text>
          {gate.canUsePrivateApi ? (
            <Button
              size="sm"
              tone="accent"
              appearance="solid"
              leadingIcon={RiAddLine}
              onPress={() => setNaming(true)}
            >
              {t('saved.list.new')}
            </Button>
          ) : null}
        </View>

        {gate.isPending ? (
          <Text className="text-muted-foreground" accessibilityLiveRegion="polite">
            {t('saved.loading')}
          </Text>
        ) : !gate.canUsePrivateApi ? (
          <PanelState
            icon={RiLockLine}
            title={t('saved.signedOut.title')}
            body={t('saved.signedOut.body')}
            actionLabel={t('saved.signedOut.button')}
            actionIcon={RiBookmarkLine}
            onAction={() => gate.run(() => undefined)}
            testID="saved-signed-out"
          />
        ) : lists.isPending ? (
          <Text className="text-muted-foreground" accessibilityLiveRegion="polite">
            {t('saved.loading')}
          </Text>
        ) : lists.isError ? (
          <PanelState
            icon={RiErrorWarningLine}
            title={t('saved.retry.message')}
            actionLabel={t('saved.retry.button')}
            onAction={() => void lists.refetch()}
            testID="saved-error"
          />
        ) : lists.data.length === 0 ? (
          <PanelState
            icon={RiBookmarkLine}
            title={t('saved.empty.title')}
            body={t('saved.empty.body')}
            testID="saved-empty"
          />
        ) : (
          <View className="gap-space-12" accessibilityRole="list">
            {lists.data.map((list) => (
              <PlaceListCard
                key={list.id}
                name={list.name}
                count={list.itemCount}
                countLabel={(count) => t(pluralKey('saved.count', count), { count })}
                photos={list.coverPlaceIds.flatMap((id) => {
                  const photo = covers.places.get(id)?.coverFileId;
                  return photo ? [photo] : [];
                })}
                photoVariant="thumb"
                empty={<RiMapPin2Line width={28} height={28} />}
                icon={list.isDefault ? RiBookmarkLine : undefined}
                visibility={list.visibility}
                onPress={() => open(list.id)}
                testID={`saved-list-${list.id}`}
              />
            ))}
          </View>
        )}

        {gate.canUsePrivateApi ? (
          <Text className="text-caption text-muted-foreground">{t('saved.private')}</Text>
        ) : null}
      </ScrollView>

      {naming ? (
        <ListNameDialog
          title={t('saved.list.new')}
          confirmLabel={t('saved.list.create')}
          onSubmit={createList}
          onClose={() => setNaming(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}
