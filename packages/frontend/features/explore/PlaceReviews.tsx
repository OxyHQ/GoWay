/**
 * A place's reviews: the summary GoWay derives, the reviews in the order the
 * reader picks, the business's replies, and the reader's own review.
 *
 * ## What is shown, and what is never computed here
 *
 * The stars and the count are `Place.rating` — GoWay's, derived from the
 * published reviews on every write. This screen never averages the page it
 * holds, which would show a number no other client shows. A reviewer is named
 * by their public Oxy profile, resolved by the Oxy SDK from the id the review
 * carries; a reply is "from the business" and never names a person.
 *
 * ## Writing is identity-bound, and refused to the business
 *
 * "Write a review" goes through the auth gate. GoWay refuses a review by
 * anybody affiliated with the place's claimant and by a session switched into
 * an organization; the form says so in words rather than as a failed save.
 *
 * The section is absent for a place with no reviews and no reader who could
 * write one.
 */
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { GoWayForbiddenError, type Place, type PlaceReview, type ReviewSort } from '@goway.to/sdk';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Rating, RatingInput } from '@oxy.so/bloom/rating';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Textarea } from '@oxy.so/bloom/textarea';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';

import { useAuthGate } from '@/lib/authGate';
import { classifyGoWayError } from '@/lib/goway/errors';
import {
  useMyPlaceReview,
  usePlaceReviews,
  useReviewAuthors,
  useWithdrawReview,
  useWriteReview,
} from '@/lib/goway/queries';
import {
  REVIEW_SORT_LABELS,
  ratingSummary,
  reviewAge,
  reviewerName,
  spokenReview,
} from '@/lib/goway/reviews';
import type { User } from '@oxy.so/core';

const SORTS = Object.keys(REVIEW_SORT_LABELS) as ReviewSort[];

export interface PlaceReviewsProps {
  place: Place;
}

/** Why a save failed, in words the person can act on. */
function writeFailure(error: Error): string {
  if (error instanceof GoWayForbiddenError) {
    return 'GoWay does not take reviews from the business itself, or from a session acting as an organization. Reply to reviews instead.';
  }
  const { kind } = classifyGoWayError(error);
  if (kind === 'unavailable' || kind === 'offline' || kind === 'timeout')
    return 'Your review could not be saved right now. Try again shortly.';
  if (kind === 'rateLimited') return 'You have written a lot recently. Try again in a few minutes.';
  return 'Your review could not be saved.';
}

function ReviewRow({ review, author }: { review: PlaceReview; author: User | undefined }) {
  const name = reviewerName(author);
  return (
    <View className="gap-space-4" accessible accessibilityLabel={spokenReview(review, name)}>
      <View className="flex-row items-center gap-space-8">
        <Avatar source={author?.avatar ?? null} name={name} size="sm" />
        <View className="flex-1">
          <Text className="text-bodySmall text-foreground">{name}</Text>
          <View className="flex-row items-center gap-space-8">
            <Rating value={review.rating} variant="stars" size="small" />
            <Text className="text-caption text-muted-foreground">
              {reviewAge(review.editedAt ?? review.createdAt)}
              {review.editedAt ? ' · edited' : ''}
            </Text>
          </View>
        </View>
      </View>
      {review.title ? <Text className="text-body text-foreground">{review.title}</Text> : null}
      {review.body ? <Text className="text-bodySmall text-foreground">{review.body}</Text> : null}
      {review.reply ? (
        <View
          className="gap-space-2 rounded-radius-md bg-muted p-space-8"
          accessibilityLabel={`Response from the business: ${review.reply.body}`}
        >
          <Text className="text-caption text-muted-foreground">Response from the business</Text>
          <Text className="text-bodySmall text-foreground">{review.reply.body}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ReviewForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: { rating: number | null; title: string; body: string };
  onSave: (draft: { rating: number; title: string; body: string }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [rating, setRating] = useState<number | null>(initial.rating);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  return (
    <View className="gap-space-8">
      <RatingInput value={rating} onChange={setRating} size="lg" accessibilityLabel="Your rating" />
      <TextField size="sm">
        <TextFieldInput
          label="Title (optional)"
          value={title}
          onChangeText={setTitle}
          maxLength={120}
        />
      </TextField>
      <Textarea
        label="Your review (optional)"
        value={body}
        onChangeText={setBody}
        rows={4}
        maxLength={4000}
      />
      <View className="flex-row gap-space-8">
        <Button
          size="sm"
          tone="accent"
          appearance="solid"
          disabled={rating === null || saving}
          onPress={() => {
            if (rating !== null) onSave({ rating, title, body });
          }}
        >
          {saving ? 'Saving…' : 'Save review'}
        </Button>
        <Button size="sm" tone="neutral" appearance="outline" onPress={onCancel} disabled={saving}>
          Cancel
        </Button>
      </View>
    </View>
  );
}

export function PlaceReviews({ place }: PlaceReviewsProps) {
  const gate = useAuthGate();
  const [sort, setSort] = useState<ReviewSort>('newest');
  const [editing, setEditing] = useState(false);
  const reviews = usePlaceReviews(place.id, sort);
  const mine = useMyPlaceReview(place.id, gate.canUsePrivateApi);
  const write = useWriteReview(place.id);
  const withdraw = useWithdrawReview(place.id);

  const items = useMemo(() => reviews.data?.items ?? [], [reviews.data]);
  const authors = useReviewAuthors(items.map((review) => review.authorOxyUserId));
  const own = mine.data ?? null;

  const startWriting = useCallback(() => {
    gate.run(() => setEditing(true));
  }, [gate]);

  const save = useCallback(
    (draft: { rating: number; title: string; body: string }) => {
      write.mutate(
        {
          rating: draft.rating,
          ...(draft.title.trim() ? { title: draft.title } : {}),
          ...(draft.body.trim() ? { body: draft.body } : {}),
        },
        { onSuccess: () => setEditing(false) },
      );
    },
    [write],
  );

  if (!place.rating && items.length === 0 && !gate.canUsePrivateApi) return null;

  return (
    <View className="gap-space-12" accessibilityLabel="Reviews">
      <View className="flex-row items-center justify-between gap-space-8">
        <Text className="text-body text-foreground">Reviews</Text>
        {place.rating ? (
          <View
            className="flex-row items-center gap-space-8"
            accessible
            accessibilityLabel={`Rated ${ratingSummary(place.rating)}`}
          >
            <Rating
              value={place.rating.average}
              count={place.rating.count}
              countStyle="reviews"
              variant="stars"
              size="small"
            />
          </View>
        ) : null}
      </View>

      {editing ? (
        <View className="gap-space-4">
          <ReviewForm
            initial={{
              rating: own?.rating ?? null,
              title: own?.title ?? '',
              body: own?.body ?? '',
            }}
            onSave={save}
            onCancel={() => setEditing(false)}
            saving={write.isPending}
          />
          {write.error ? (
            <Text className="text-bodySmall text-muted-foreground" accessibilityLiveRegion="polite">
              {writeFailure(write.error)}
            </Text>
          ) : null}
        </View>
      ) : own ? (
        <View className="gap-space-4">
          <Text className="text-caption text-muted-foreground">
            {own.status === 'hidden' ? 'Your review is hidden by GoWay moderation.' : 'Your review'}
          </Text>
          <View className="flex-row gap-space-8">
            <Button size="sm" tone="neutral" appearance="outline" onPress={() => setEditing(true)}>
              Edit your review
            </Button>
            <Button
              size="sm"
              tone="neutral"
              appearance="plain"
              onPress={() => withdraw.mutate()}
              disabled={withdraw.isPending}
            >
              Withdraw
            </Button>
          </View>
        </View>
      ) : (
        <View className="flex-row">
          <Button
            size="sm"
            leadingIcon={RiQuillPenLine}
            onPress={startWriting}
            accessibilityLabel={
              gate.canUsePrivateApi ? `Review ${place.name}` : `Sign in to review ${place.name}`
            }
            tone="neutral"
            appearance="outline"
          >
            Write a review
          </Button>
        </View>
      )}

      {items.length > 1 ? (
        <SegmentedControl
          type="tabs"
          size="sm"
          value={sort}
          onValueChange={setSort}
          label="Order reviews by"
        >
          {SORTS.map((value) => (
            <SegmentedControlItem key={value} value={value}>
              <SegmentedControlItemText>{REVIEW_SORT_LABELS[value]}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      ) : null}

      {items.map((review) => (
        <ReviewRow
          key={review.id}
          review={review}
          author={authors.data?.get(review.authorOxyUserId)}
        />
      ))}
    </View>
  );
}
