/**
 * "Products at this store": what a Mercaria shop trading from this place has
 * on its shelf, read from Mercaria every time and stored nowhere in GoWay.
 *
 * ## Who decides what is shown
 *
 * The place's `commerce.mercaria.store` capability only decides whether to
 * ASK. Mercaria answers which of its locations trade from this place — only
 * while the place names the location back at the business's tier or GoWay's —
 * and that answer is the whole of what renders: the store's name and logo, its
 * in-stock products, and a link to its page on mercaria.co. A capability
 * Mercaria does not confirm draws nothing.
 *
 * A place usually has one shop front or none; a market or a mall can have
 * several, and each is its own block, dropping out alone if its read fails.
 *
 * ## States
 *
 * Skeleton tiles while Mercaria answers. Nothing at all for an empty page,
 * `gone` or `not_found` — a withdrawn store is not an error to show. A quiet
 * "Try again" when Mercaria could not answer right now: a 503 there usually
 * means it could not ask GoWay, which says nothing about the store.
 *
 * ## What a tile says
 *
 * The price in the listing's own currency, and the shop's availability in
 * WORDS — in stock, low stock, out of stock — with the count only where the
 * merchant discloses it, and when the shop last confirmed it. The badge's
 * colour repeats the word; it never replaces it. Each tile and the store link
 * open mercaria.co, which is where buying happens.
 *
 * Every word is a message (`lib/messages/products.ts`) read through
 * `useTranslation`; only the store's name and the product's title are
 * Mercaria's own.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { Place } from '@goway.to/sdk';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { RiShoppingBag3Line } from '@oxy.so/bloom/icons/RiShoppingBag3Line';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';

import { useTranslation } from '@/lib/i18n';
import { mercariaReadState } from '@/lib/mercaria/errors';
import {
  formatMercariaPrice,
  placeOffersMercariaStore,
  presentStock,
  spokenProduct,
} from '@/lib/mercaria/presentation';
import {
  useMercariaLocationProducts,
  usePlaceMercariaLocations,
  type MercariaLocation,
  type MercariaLocationProduct,
} from '@/lib/mercaria/queries';

/** One tile's edge, in points — the gallery's, so the two strips line up. */
const TILE = 120;

/** "Stock confirmed … ago" is counted in minutes, so it is re-read once a minute. */
const CLOCK_TICK_MS = 60_000;

/** The time the ages are counted to, advancing while the sheet stays open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export interface PlaceProductsProps {
  place: Place;
}

function openOnMercaria(url: string) {
  void WebBrowser.openBrowserAsync(url);
}

function ProductTile({ item, now }: { item: MercariaLocationProduct; now: number }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const stock = presentStock(item, t, now);
  const image = broken ? null : item.product.primaryImage;

  return (
    <Pressable
      onPress={() => openOnMercaria(item.product.url)}
      accessibilityRole="link"
      accessibilityLabel={t('products.tile.label', { product: spokenProduct(item, t, now) })}
      className="gap-space-4"
      style={{ width: TILE }}
    >
      <View
        className="items-center justify-center overflow-hidden rounded-radius-md bg-muted"
        style={{ width: TILE, height: TILE }}
      >
        {image ? (
          <Image
            source={{ uri: image.url }}
            style={{ width: TILE, height: TILE }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
            onError={() => setBroken(true)}
          />
        ) : (
          <RiShoppingBag3Line width={28} height={28} fill={theme.colors.textSecondary} />
        )}
      </View>
      <Text className="text-bodySmall text-foreground" numberOfLines={2}>
        {item.product.title}
      </Text>
      <Text className="text-bodySmall text-foreground">
        {formatMercariaPrice(item.product.price)}
      </Text>
      <View className="flex-row flex-wrap items-center gap-space-4">
        <Badge content={stock.label} size="label-small" variant="subtle" color={stock.tone} />
        {stock.quantity ? (
          <Text className="text-caption text-muted-foreground">{stock.quantity}</Text>
        ) : null}
      </View>
      <Text className="text-caption text-muted-foreground" numberOfLines={2}>
        {stock.confirmed}
      </Text>
    </Pressable>
  );
}

function StripSkeleton() {
  const { t } = useTranslation();
  return (
    <View accessibilityLabel={t('products.loading')}>
      <Skeleton.Row style={{ gap: 8 }}>
        {[0, 1, 2].map((index) => (
          <Skeleton.Col key={index} style={{ gap: 6 }}>
            <Skeleton.Box width={TILE} height={TILE} borderRadius={12} />
            <Skeleton.Box width={TILE * 0.8} height={10} />
            <Skeleton.Box width={TILE * 0.4} height={10} />
          </Skeleton.Col>
        ))}
      </Skeleton.Row>
    </View>
  );
}

/** Mercaria could not answer right now. Quiet, because the rest of the place is unaffected. */
function QuietRetry({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-space-8" accessibilityLiveRegion="polite">
      <Text className="flex-1 text-bodySmall text-muted-foreground">
        {t('products.retry.message')}
      </Text>
      <Button size="sm" tone="neutral" appearance="plain" onPress={onRetry} disabled={retrying}>
        {retrying ? t('products.retry.trying') : t('products.retry.button')}
      </Button>
    </View>
  );
}

function StoreProducts({
  location,
  items,
  loading,
  onRetry,
  retrying,
  now,
}: {
  location: MercariaLocation;
  items: readonly MercariaLocationProduct[] | null;
  loading: boolean;
  onRetry: (() => void) | null;
  retrying: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  const { store } = location;
  const openStore = useCallback(() => openOnMercaria(location.url), [location.url]);

  return (
    <View className="gap-space-8">
      <View className="flex-row items-center gap-space-8">
        <Avatar source={store.logoUrl} name={store.name} size="sm" />
        <View className="flex-1">
          <Text className="text-bodySmall text-foreground">{store.name}</Text>
          <Text className="text-caption text-muted-foreground">
            {t('products.store.onMercaria')}
          </Text>
        </View>
      </View>

      {loading ? <StripSkeleton /> : null}
      {onRetry ? <QuietRetry onRetry={onRetry} retrying={retrying} /> : null}
      {items && items.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-space-8"
        >
          {items.map((item) => (
            <ProductTile key={item.product.ref.id} item={item} now={now} />
          ))}
        </ScrollView>
      ) : null}
      {items && items.length === 0 ? (
        <Text className="text-bodySmall text-muted-foreground">{t('products.store.empty')}</Text>
      ) : null}

      <View className="flex-row">
        <Button
          size="sm"
          leadingIcon={RiStore2Line}
          onPress={openStore}
          accessibilityRole="link"
          accessibilityLabel={t('products.store.seeAllLabel', { store: store.name })}
          tone="neutral"
          appearance="outline"
        >
          {t('products.store.seeAll', { store: store.name })}
        </Button>
      </View>
    </View>
  );
}

export function PlaceProducts({ place }: PlaceProductsProps) {
  const { t } = useTranslation();
  const now = useMinuteClock();
  const locations = usePlaceMercariaLocations(place);
  // Only a list Mercaria is confirming NOW names stores: a refresh that fails
  // keeps React Query's last `data`, and those links may since have been
  // withdrawn, so a failed list shows the retry and nothing it no longer vouches for.
  const found = locations.status === 'success' ? locations.data.items : [];
  const shelves = useMercariaLocationProducts(found);

  if (!placeOffersMercariaStore(place)) return null;

  const state = mercariaReadState({
    status: locations.status,
    error: locations.error,
    empty: found.length === 0,
  });
  if (state === 'hidden') return null;

  // A store whose own read is gone, not found or unknown drops out alone.
  const stores = found
    .map((location, index) => ({
      location,
      shelf: shelves[index],
      state: mercariaReadState({
        status: shelves[index].status,
        error: shelves[index].error,
        empty: false,
      }),
    }))
    .filter((store) => store.state !== 'hidden');
  if (state === 'ready' && stores.length === 0) return null;

  const heading = t(stores.length > 1 ? 'products.heading.other' : 'products.heading.one');

  return (
    <View className="gap-space-12" accessibilityLabel={heading}>
      <Text className="text-body text-foreground" accessibilityRole="header">
        {heading}
      </Text>

      {state === 'loading' ? <StripSkeleton /> : null}
      {state === 'retry' ? (
        <QuietRetry onRetry={() => void locations.refetch()} retrying={locations.isFetching} />
      ) : null}

      {stores.map(({ location, shelf, state: shelfState }) => (
        <StoreProducts
          key={location.ref.id}
          location={location}
          items={shelfState === 'ready' ? (shelf.data?.items ?? []) : null}
          loading={shelfState === 'loading'}
          onRetry={shelfState === 'retry' ? () => void shelf.refetch() : null}
          retrying={shelf.isFetching}
          now={now}
        />
      ))}
    </View>
  );
}
