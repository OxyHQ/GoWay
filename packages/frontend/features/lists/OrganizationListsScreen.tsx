import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useOxy } from '@oxy.so/services';
import type { AccountNode } from '@oxy.so/core';
import {
  placeDisplayName,
  type OrganizationList,
  type OrganizationListEntry,
  type OrganizationListEntryInput,
  type Place,
  type SearchResult,
} from '@goway.to/sdk';
import { gowayClient } from '@/lib/goway/client';
import { oxyServices } from '@/lib/oxyServices';
import { useAuthGate } from '@/lib/authGate';
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
function useOrganizations() {
  const { canUsePrivateApi, user } = useOxy();
  const [organizations, setOrganizations] = useState<AccountNode[]>([]);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed session must discard the previous account's choices.
  useEffect(() => {
    let active = true;
    setOrganizations([]);
    setFailed(false);
    if (canUsePrivateApi)
      void oxyServices.accounts
        .list()
        .then((nodes) => {
          if (active) setOrganizations(editableOrganizations(nodes));
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
    };
  }, [canUsePrivateApi, user?.id]);
  return { organizations, failed };
}
function nameOf(org: AccountNode) {
  return org.account.name?.displayName || org.account.username || org.accountId;
}

export function OrganizationListsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const { organizations, failed } = useOrganizations();
  const { user } = useOxy();
  const [items, setItems] = useState<OrganizationList[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset draft ownership whenever the selected Oxy session changes.
  useEffect(() => {
    setAccountId('');
    setTitle('');
    setDescription('');
  }, [user?.id]);
  const load = useCallback(async (next?: string) => {
    setBusy(true);
    setError(false);
    try {
      const page = await gowayClient.organizationLists.list(next ? { cursor: next } : {});
      setItems((old) => (next ? [...old, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function create() {
    if (!gate.canUsePrivateApi || busy) return;
    setBusy(true);
    setError(false);
    try {
      const list = await gowayClient.organizationLists.create({
        oxyAccountId: accountId,
        title,
        description,
      });
      router.push({ pathname: '/lists/[listId]', params: { listId: list.id } });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-space-16 p-space-16 w-full max-w-3xl self-center">
        <Button appearance="outline" onPress={() => router.push('/')}>
          {t('lists.map')}
        </Button>
        <Text className="text-sectionTitle text-foreground">{t('lists.title')}</Text>
        <Text>{t('lists.public')}</Text>
        {(error || failed) && <Text accessibilityRole="alert">{t('lists.error')}</Text>}
        <Button appearance="outline" disabled={busy} onPress={() => void load()}>
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
        {cursor && (
          <Button disabled={busy} onPress={() => void load(cursor)}>
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
            <Button disabled={busy || !accountId || !title.trim()} onPress={() => void create()}>
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
  onSave: (input: OrganizationListEntryInput) => Promise<void>;
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
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setSelected(null);
    if (placeId)
      void gowayClient.places
        .get(placeId, { signal: abort.signal })
        .then(setSelected)
        .catch(() => {});
    return () => abort.abort();
  }, [placeId]);
  useEffect(() => {
    const abort = new AbortController();
    setResults([]);
    if (query.trim().length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true);
      void gowayClient.search
        .query({ query: query.trim() }, { signal: abort.signal })
        .then((page) => setResults(page.items.filter((p) => p.placeId)))
        .catch(() => {
          if (!abort.signal.aborted) setError(t('lists.error'));
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, t]);
  async function save() {
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
    await onSave(input);
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
      {!!error && <Text accessibilityRole="alert">{error}</Text>}
      <Button disabled={busy || !activity.trim() || !selected} onPress={() => void save()}>
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
  const { organizations } = useOrganizations();
  const [list, setList] = useState<OrganizationList | null>(null);
  const [entries, setEntries] = useState<OrganizationListEntry[]>([]);
  const [places, setPlaces] = useState<Map<string, Place>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<OrganizationListEntry | 'new' | null>(null);
  const [editList, setEditList] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const canEdit =
    gate.canUsePrivateApi &&
    !!list &&
    organizations.some((org) => org.accountId === list.oxyAccountId);
  const requestVersion = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: editor state belongs to one session and list.
  useEffect(() => {
    setManage(false);
    setEditing(null);
    setEditList(false);
    setConfirm(null);
  }, [user?.id, listId]);
  const load = useCallback(
    async (next?: string) => {
      const version = ++requestVersion.current;
      setBusy(true);
      setError(false);
      if (!next) {
        setEntries([]);
        setPlaces(new Map());
      }
      try {
        const [detail, page] = await Promise.all([
          gowayClient.organizationLists.get(listId),
          gowayClient.organizationLists.entries(listId, {
            state: all || manage ? 'all' : 'active',
            ...(next ? { cursor: next } : {}),
          }),
        ]);
        if (version !== requestVersion.current) return;
        setList(detail);
        setEntries((old) => (next ? [...old, ...page.items] : page.items));
        setCursor(page.nextCursor);
        const ids = [...new Set(page.items.map((e) => e.placeId))];
        if (ids.length) {
          const current = await gowayClient.places.getMany(ids);
          if (version === requestVersion.current)
            setPlaces(
              (old) =>
                new Map([
                  ...(next ? old : new Map<string, Place>()),
                  ...current.items.map((p) => [p.id, p] as const),
                ]),
            );
        }
      } catch {
        if (version === requestVersion.current) setError(true);
      } finally {
        if (version === requestVersion.current) setBusy(false);
      }
    },
    [listId, all, manage],
  );
  useEffect(() => {
    void load();
    return () => {
      requestVersion.current++;
    };
  }, [load]);
  // Expiry is decided by the server; refresh while open so an idle screen also drops ended entries.
  useEffect(() => {
    const timer = setInterval(() => {
      void load();
    }, 60000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (all || manage || entries.length === 0) return;
    const end = Math.min(...entries.map((entry) => Date.parse(entry.endsAt)));
    const delay = Math.min(2147483647, Math.max(1, end - Date.now() + 10));
    const timer = setTimeout(() => {
      void load();
    }, delay);
    return () => clearTimeout(timer);
  }, [entries, all, manage, load]);
  async function mutate(fn: () => Promise<unknown>) {
    if (!canEdit || busy) return;
    setBusy(true);
    setError(false);
    try {
      await fn();
      setEditing(null);
      setEditList(false);
      setConfirm(null);
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function moveUp(entry: OrganizationListEntry) {
    if (!list) return;
    const ids: string[] = [];
    for await (const item of gowayClient.organizationLists.iterateEntries(listId, { state: 'all' }))
      ids.push(item.id);
    const index = ids.indexOf(entry.id);
    if (index <= 0) return;
    const previous = ids[index - 1];
    const current = ids[index];
    if (previous === undefined || current === undefined) return;
    [ids[index - 1], ids[index]] = [current, previous];
    await gowayClient.organizationLists.order(listId, { revision: list.revision, entryIds: ids });
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
                }).catch(() => setError(true))
              }
            >
              {t('lists.share')}
            </Button>
          </>
        )}
        {error && <Text accessibilityRole="alert">{t('lists.error')}</Text>}
        <Button disabled={busy} appearance="outline" onPress={() => void load()}>
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
                void mutate(async () => {
                  await gowayClient.organizationLists.delete(listId);
                  router.replace('/lists');
                });
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
              onPress={() =>
                void mutate(() =>
                  gowayClient.organizationLists.update(listId, { title, description }),
                )
              }
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
              mutate(() =>
                editing === 'new'
                  ? gowayClient.organizationLists.addEntry(listId, input)
                  : gowayClient.organizationLists.updateEntry(listId, editing.id, input),
              )
            }
          />
        )}
        {!busy && entries.length === 0 && <Text>{t('lists.empty')}</Text>}
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
                      onPress={() =>
                        void mutate(() =>
                          gowayClient.organizationLists.completeEntry(listId, entry.id),
                        )
                      }
                    >
                      {t('lists.complete')}
                    </Button>
                  )}
                  <Button
                    disabled={busy || entry.position === 0}
                    appearance="outline"
                    onPress={() => void mutate(() => moveUp(entry))}
                  >
                    {t('lists.up')}
                  </Button>
                  <Button
                    disabled={busy}
                    appearance="outline"
                    onPress={() =>
                      confirm === entry.id
                        ? void mutate(() =>
                            gowayClient.organizationLists.deleteEntry(listId, entry.id),
                          )
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
        {busy && <ActivityIndicator />}
        {cursor && (
          <Button disabled={busy} onPress={() => void load(cursor)}>
            {t('lists.more')}
          </Button>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
