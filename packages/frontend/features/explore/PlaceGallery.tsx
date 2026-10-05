/**
 * A place's photos, as a strip — and the one way to add to them.
 *
 * Every image is an Oxy file, drawn from Oxy's CDN through Bloom's image
 * resolver: GoWay hands the app file ids and never an image. A tile whose image
 * does not load is DROPPED rather than drawn as a broken frame — the owner may
 * have made the file private since, and a grey box is a worse answer than no
 * box. An imported image carries its credit under it, because its licence asks
 * for that where it is shown.
 *
 * The section is absent for a place with no photos and nobody signed in to add
 * one: an empty gallery frame is the "imitate density" this sheet refuses. With
 * a session it offers "Add photo", which goes through the auth gate like every
 * identity-bound action here.
 */
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { PlaceId } from '@goway.to/sdk';
import { Image } from 'expo-image';
import { Button } from '@oxy.so/bloom/button';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import { Text } from '@oxy.so/bloom/typography';
import { RiImageAddLine } from '@oxy.so/bloom/icons/RiImageAddLine';

import { useAuthGate } from '@/lib/authGate';
import { classifyGoWayError } from '@/lib/goway/errors';
import { useAddPlacePhoto, usePlaceMedia } from '@/lib/goway/queries';
import { mediaCredit, stripItems } from '@/lib/goway/reviews';

import { pickPlacePhoto } from './placePhoto';

/** One tile's edge, in points. */
const TILE = 120;

export interface PlaceGalleryProps {
  placeId: PlaceId;
  placeName: string;
}

/** What a failed upload tells the person, in words they can act on. */
function uploadFailure(error: Error): string {
  const { kind } = classifyGoWayError(error);
  if (kind === 'unavailable' || kind === 'offline' || kind === 'timeout') return 'The photo could not be added right now. Try again shortly.';
  if (kind === 'rateLimited') return 'You have added a lot recently. Try again in a few minutes.';
  return 'The photo could not be added.';
}

export function PlaceGallery({ placeId, placeName }: PlaceGalleryProps) {
  const gate = useAuthGate();
  const resolve = useImageResolver();
  const media = usePlaceMedia(placeId);
  const addPhoto = useAddPlacePhoto(placeId);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());

  const items = stripItems(media.data?.items ?? []).filter((item) => !broken.has(item.id));

  const add = useCallback(() => {
    gate.run(() => {
      void pickPlacePhoto().then((image) => {
        if (image) addPhoto.mutate({ image });
      });
    });
  }, [gate, addPhoto]);

  if (items.length === 0 && !gate.canUsePrivateApi) return null;

  return (
    <View className="gap-space-8" accessibilityLabel={`Photos of ${placeName}`}>
      {items.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-space-8">
          {items.map((item) => {
            const credit = mediaCredit(item);
            const uri = resolve?.(item.fileId, 'thumb');
            if (!uri) return null;
            return (
              <View key={item.id} className="gap-space-2" style={{ width: TILE }}>
                <View className="overflow-hidden rounded-radius-md bg-muted" style={{ width: TILE, height: TILE }}>
                  <Image
                    source={{ uri }}
                    style={{ width: TILE, height: TILE }}
                    contentFit="cover"
                    accessibilityLabel={item.caption ?? `Photo of ${placeName}`}
                    onError={() => setBroken((previous) => new Set(previous).add(item.id))}
                  />
                </View>
                {credit ? (
                  <Text className="text-caption text-muted-foreground" numberOfLines={2}>
                    {credit}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      <View className="flex-row items-center gap-space-8">
        <Button
          size="sm"
          leadingIcon={RiImageAddLine}
          onPress={add}
          disabled={addPhoto.isPending}
          accessibilityLabel={gate.canUsePrivateApi ? `Add a photo of ${placeName}` : `Sign in to add a photo of ${placeName}`}
          tone="neutral"
          appearance="outline"
        >
          {addPhoto.isPending ? 'Adding…' : 'Add photo'}
        </Button>
        {addPhoto.error ? (
          <Text className="flex-1 text-bodySmall text-muted-foreground" accessibilityLiveRegion="polite">
            {uploadFailure(addPhoto.error)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
