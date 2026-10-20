import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useOxy } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import {
  placeDisplayName,
  type OrganizationListEntry,
  type OrganizationListEntryInput,
} from '@goway.to/sdk';
import {
  MIN_SEARCH_LENGTH,
  useCreateOrganizationList,
  useEditOrganizationList,
  useOrganizationList,
  useOrganizationListEntries,
  useOrganizationListPlaces,
  useOrganizationLists,
  usePlace,
  useRefreshOrganizationList,
  useSearch,
  type OrganizationListEdit,
} from '@/lib/goway/queries';
import { useAuthGate } from '@/lib/authGate';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useTranslation } from '@/lib/i18n';
import { SearchField } from '@/features/explore/SearchField';
import { editableOrganizations, utcInput, parseUtcInput } from './model';

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <TextField>
      <Text className="text-bodySmall text-muted-foreground">{label}</Text>
      <TextFieldInput
        label={label}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
      />
    </TextField>
  );
}
/** The organizations the session may edit for, from the account graph `OxyProvider` already keeps. */
function useOrganizations(): AccountNode[] {
  const { canUsePrivateApi, accounts } = useOxy();
  return useMemo(
    () => (canUsePrivateApi ? editableOrganizations(accounts) : []),
    [canUsePrivateApi, accounts],
  );
}
function nameOf(org: AccountNode) {
  return org.account.name?.displayName || org.account.username || org.accountId;
}

export function OrganizationListsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const organizations = useOrganizations();
  const { user } = useOxy();
  const lists = useOrganizationLists();
  const creation = useCreateOrganizationList();
  const items = lists.data?.pages.flatMap((page) => page.items) ?? [];
  const busy = lists.isFetching || creation.isPending;
  const [accountId, setAccountId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset draft ownership whenever the selected Oxy session changes.
  useEffect(() => {
    setAccountId('');
    setTitle('');
    setDescription('');
  }, [user?.id]);
  function create() {
    if (!gate.canUsePrivateApi || busy) return;
    creation.mutate(
      { oxyAccountId: accountId, title, description },
      {
        onSuccess: (list) =>
          router.push({ pathname: '/lists/[listId]', params: { listId: list.id } }),
      },
    );
  }
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-space-16 p-space-16 w-full max-w-3xl self-center">
        <Button appearance="outline" onPress={() => router.push('/')}>
          {t('lists.map')}
        </Button>
        <Text className="text-sectionTitle text-foreground">{t('lists.title')}</Text>
        <Text>{t('lists.public')}</Text>
        {(lists.isError || creation.isError) && (
          <Text accessibilityRole="alert">{t('lists.error')}</Text>
        )}
        <Button appearance="outline" disabled={busy} onPress={() => void lists.refetch()}>
          {t('lists.refresh')}
        </Button>
        {items.map((list) => (
          <Button
            key={list.id}
            appearance="outline"
            onPress={() =>
              router.push({ pathname: '/lists/[listId]', params: { listId: list.id } })
            }
          >
            {list.title}
          </Button>
        ))}
        {busy && <ActivityIndicator />}
        {lists.hasNextPage && (
          <Button disabled={busy} onPress={() => void lists.fetchNextPage()}>
            {t('lists.more')}
          </Button>
        )}
        {!gate.canUsePrivateApi ? (
          <Button onPress={() => gate.run(() => {})}>{t('lists.signIn')}</Button>
        ) : (
          <View className="gap-space-12">
            <Text className="text-sectionTitle">{t('lists.create')}</Text>
            <Text>{t('lists.organization')}</Text>
            {organizations.length === 0 && <Text>{t('lists.noOrganizations')}</Text>}
            {organizations.map((org) => (
              <Button
                key={org.accountId}
                appearance={accountId === org.accountId ? 'solid' : 'outline'}
                onPress={() => setAccountId(org.accountId)}
              >
                {nameOf(org)}
              </Button>
            ))}
            <Field label={t('lists.name')} value={title} onChange={setTitle} />
            <Field label={t('lists.description')} value={description} onChange={setDescription} />
            <Button disabled={busy || !accountId || !title.trim()} onPress={create}>
              {t('lists.create')}
            </Button>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EntryEditor({
  entry,
  initialPlaceId,
  onSave,
  onCancel,
  busy,
}: {
  entry: OrganizationListEntry | null;
  initialPlaceId?: string;
  onSave: (input: OrganizationListEntryInput) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [placeId, setPlaceId] = useState(entry?.placeId ?? initialPlaceId ?? '');
  const [activity, setActivity] = useState(entry?.activity ?? '');
  const [information, setInformation] = useState(entry?.information ?? '');
  const [starts, setStarts] = useState(utcInput(entry?.startsAt ?? new Date().toISOString()));
  const [ends, setEnds] = useState(
    utcInput(entry?.endsAt ?? new Date(Date.now() + 3600000).toISOString()),
  );
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const selected = usePlace(placeId || null).data ?? null;
  const debounced = useDebouncedValue(query, 250);
  // Only the settled query's answer is shown: a result list never lags the field.
  const settled = debounced === query && query.trim().length >= MIN_SEARCH_LENGTH;
  const search = useSearch(debounced, { enabled: settled });
  const searching = search.isFetching;
  const results = settled ? (search.data?.items.filter((p) => p.placeId) ?? []) : [];
  function save() {
    let input: OrganizationListEntryInput;
    try {
      const startsAt = parseUtcInput(starts);
      const endsAt = parseUtcInput(ends);
      if (!selected || endsAt <= startsAt) throw new Error();
      input = { placeId, activity, information, startsAt, endsAt };
    } catch {
      setError(t('lists.dateError'));
      return;
    }
    setError('');
    onSave(input);
  }
  return (
    <View className="gap-space-12 rounded-radius-lg border border-border p-space-16">
      <SearchField
        value={query}
        onChangeText={setQuery}
        onClear={() => setQuery('')}
        busy={searching}
        placeholder={t('lists.place')}
      />
      {query.length > 1 && !searching && results.length === 0 && <Text>{t('lists.noPlaces')}</Text>}
      {results.map((result) => (
        <Button
          key={result.id}
          appearance="outline"
          onPress={() => {
            setPlaceId(result.placeId ?? '');
            setQuery('');
          }}
        >
          {result.displayName}
        </Button>
      ))}
      {selected && <Text>{t('lists.selected', { name: placeDisplayName(selected) })}</Text>}
      <Field label={t('lists.activity')} value={activity} onChange={setActivity} />
      <Field label={t('lists.information')} value={information} onChange={setInformation} />
      <Text>{t('lists.utc')}</Text>
      <Field label={t('lists.starts')} value={starts} onChange={setStarts} />
      <Field label={t('lists.ends')} value={ends} onChange={setEnds} />
      {(!!error || (settled && search.isError)) && (
        <Text accessibilityRole="alert">{error || t('lists.error')}</Text>
      )}
      <Button disabled={busy || !activity.trim() || !selected} onPress={save}>
        {t('lists.save')}
      </Button>
      <Button disabled={busy} appearance="outline" onPress={onCancel}>
        {t('lists.cancel')}
      </Button>
    </View>
  );
}

export function OrganizationListScreen() {
  const { listId, placeId: initialPlaceId } = useLocalSearchParams<{
    listId: string;
    placeId?: string;
  }>();
  const router = useRouter();
  const { t, locale } = useTranslation();
  const gate = useAuthGate();
  const { user } = useOxy();
  const organizations = useOrganizations();
  const [all, setAll] = useState(false);
  const [manage, setManage] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const [editing, setEditing] = useState<OrganizationListEntry | 'new' | null>(null);
  const [editList, setEditList] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const detail = useOrganizationList(listId);
  const entryPages = useOrganizationListEntries(listId, all || manage ? 'all' : 'active');
  const pages = useMemo(
    () => entryPages.data?.pages.map((page) => page.items) ?? [],
    [entryPages.data],
  );
  const entries = useMemo(() => pages.flat(), [pages]);
  const { places, isError: placesFailed } = useOrganizationListPlaces(listId, pages);
  const refresh = useRefreshOrganizationList(listId);
  const editor = useEditOrganizationList(listId);
  const list = detail.data ?? null;
  const busy = editor.isPending;
  const loading = detail.isFetching || entryPages.isFetching;
  const error =
    detail.isError || entryPages.isError || placesFailed || editor.isError || shareFailed;
  const canEdit =
    gate.canUsePrivateApi &&
    !!list &&
    organizations.some((org) => org.accountId === list.oxyAccountId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: editor state belongs to one session and list.
  useEffect(() => {
    setManage(false);
    setEditing(null);
    setEditList(false);
    setConfirm(null);
  }, [user?.id, listId]);
  function edit(change: OrganizationListEdit, after?: () => void) {
    if (!canEdit || busy) return;
    editor.mutate(change, {
      onSuccess: () => {
        setEditing(null);
        setEditList(false);
        setConfirm(null);
        after?.();
      },
    });
  }
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-space-16 p-space-16 w-full max-w-3xl self-center">
        <Button appearance="outline" onPress={() => router.push('/lists')}>
          {t('lists.title')}
        </Button>
        {list && (
          <>
            <Text className="text-sectionTitle text-foreground">{list.title}</Text>
            <Text>{list.description}</Text>
            <Text>{t('lists.public')}</Text>
            <Button
              appearance="outline"
              onPress={() =>
                void Share.share({
                  message: `https://goway.to/lists/${encodeURIComponent(listId)}`,
                }).catch(() => setShareFailed(true))
              }
            >
              {t('lists.share')}
            </Button>
          </>
        )}
        {error && <Text accessibilityRole="alert">{t('lists.error')}</Text>}
        <Button
          disabled={busy || loading}
          appearance="outline"
          onPress={() => {
            setShareFailed(false);
            void refresh();
          }}
        >
          {t('lists.refresh')}
        </Button>
        {!manage && (
          <Button appearance="outline" onPress={() => setAll(!all)}>
            {t(all ? 'lists.active' : 'lists.all')}
          </Button>
        )}
        {canEdit && (
          <Button onPress={() => setManage(!manage)}>
            {t(manage ? 'lists.finishManage' : 'lists.manage')}
          </Button>
        )}
        {manage && canEdit && list && (
          <View className="gap-space-12">
            <Button disabled={busy} onPress={() => setEditing('new')}>
              {t('lists.add')}
            </Button>
            <Button
              appearance="outline"
              onPress={() => {
                setTitle(list.title);
                setDescription(list.description);
                setEditList(true);
              }}
            >
              {t('lists.edit')}
            </Button>
            <Button
              appearance="outline"
              disabled={busy}
              onPress={() => {
                if (confirm !== 'list') {
                  setConfirm('list');
                  return;
                }
                edit({ kind: 'delete' }, () => router.replace('/lists'));
              }}
            >
              {t(confirm === 'list' ? 'lists.confirmDelete' : 'lists.delete')}
            </Button>
          </View>
        )}
        {editList && canEdit && (
          <View className="gap-space-12">
            <Field label={t('lists.name')} value={title} onChange={setTitle} />
            <Field label={t('lists.description')} value={description} onChange={setDescription} />
            <Button
              disabled={busy}
              onPress={() => edit({ kind: 'update', input: { title, description } })}
            >
              {t('lists.save')}
            </Button>
            <Button onPress={() => setEditList(false)}>{t('lists.cancel')}</Button>
          </View>
        )}
        {editing && canEdit && (
          <EntryEditor
            key={editing === 'new' ? 'new' : editing.id}
            entry={editing === 'new' ? null : editing}
            {...(initialPlaceId ? { initialPlaceId } : {})}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(input) =>
              edit(
                editing === 'new'
                  ? { kind: 'addEntry', input }
                  : { kind: 'updateEntry', entryId: editing.id, input },
              )
            }
          />
        )}
        {entryPages.isSuccess && entries.length === 0 && <Text>{t('lists.empty')}</Text>}
        {entries.map((entry) => {
          const place = places.get(entry.placeId);
          const zone = entry.timezone ?? 'UTC';
          const date = (s: string) =>
            new Intl.DateTimeFormat(locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: zone,
            }).format(new Date(s));
          return (
            <View
              key={entry.id}
              className="gap-space-8 rounded-radius-lg border border-border p-space-16"
            >
              <Text className="text-sectionTitle">{entry.activity}</Text>
              <Text>{entry.information}</Text>
              <Text>
                {date(entry.startsAt)} – {date(entry.endsAt)} ({zone})
              </Text>
              <Text>{t(`lists.${entry.status === 'active' ? 'ongoing' : entry.status}`)}</Text>
              {place ? (
                <Button
                  appearance="outline"
                  onPress={() =>
                    router.push({ pathname: '/place/[placeId]', params: { placeId: place.id } })
                  }
                >
                  {placeDisplayName(place)}
                </Button>
              ) : (
                <Text>{t('lists.unavailable')}</Text>
              )}
              {manage && canEdit && (
                <View className="flex-row flex-wrap gap-space-8">
                  <Button disabled={busy} appearance="outline" onPress={() => setEditing(entry)}>
                    {t('lists.edit')}
                  </Button>
                  {!entry.completedAt && (
                    <Button
                      disabled={busy}
                      onPress={() => edit({ kind: 'completeEntry', entryId: entry.id })}
                    >
                      {t('lists.complete')}
                    </Button>
                  )}
                  <Button
                    disabled={busy || entry.position === 0}
                    appearance="outline"
                    onPress={() =>
                      list &&
                      edit({ kind: 'moveEntryUp', entryId: entry.id, revision: list.revision })
                    }
                  >
                    {t('lists.up')}
                  </Button>
                  <Button
                    disabled={busy}
                    appearance="outline"
                    onPress={() =>
                      confirm === entry.id
                        ? edit({ kind: 'deleteEntry', entryId: entry.id })
                        : setConfirm(entry.id)
                    }
                  >
                    {t(confirm === entry.id ? 'lists.confirmDelete' : 'lists.delete')}
                  </Button>
                </View>
              )}
            </View>
          );
        })}
        {(busy || loading) && <ActivityIndicator />}
        {entryPages.hasNextPage && (
          <Button
            disabled={busy || entryPages.isFetchingNextPage}
            onPress={() => void entryPages.fetchNextPage()}
          >
            {t('lists.more')}
          </Button>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
