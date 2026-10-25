# Moderation

`client.moderation` is GoWay's moderation surface: deciding business claims, verifying capabilities, resolving duplicate places and reports, hiding gallery items and reviews, and editing the category taxonomy. It is in the SDK so GoWay's own tools are built on the same contract as everything else. No integration needs it.

Every call needs an Oxy access token whose person is on the deployment's operator allow-list. Anybody else gets `GoWayForbiddenError`; without a token, `GoWayUnauthorizedError`.

```ts
import { createGoWayClient, iterateGoWayPages } from '@goway.to/sdk';

const apiBaseUrl = 'https://api.goway.to';
const linked = oxyServices.createLinkedClient({ baseURL: apiBaseUrl });
const goway = createGoWayClient({ apiBaseUrl, fetch: linked.fetchOptional });
// Dispose linked when this component or provider closes.
```

## Claims

```ts
for await (const claim of iterateGoWayPages((cursor) => goway.moderation.claims({ state: 'pending', cursor }))) {
  await goway.moderation.decideClaim(claim.id, { state: 'approved' });
}
```

`claims()` lists `pending` claims by default, oldest first. `decideClaim` moves a claim to one of `CLAIM_DECISION_STATES`: `approved` or `rejected` decide a pending claim, `revoked` withdraws an approved one (`CLAIM_DECISION_FROM`). Any other transition is a `GoWayConflictError`.

## Places and capabilities

```ts
await goway.moderation.updatePlace('gw_place_01H8', { verificationState: 'oxy_verified' });
await goway.moderation.updatePlace('gw_place_01H8', { status: 'removed' });

await goway.moderation.verifyCapability('gw_place_01H8', 'payments.faircoin.accepted', { value: true });
await goway.moderation.withdrawVerifiedCapability('gw_place_01H8', 'payments.faircoin.accepted');

const history = await goway.moderation.revisions('gw_place_01H8');
```

- `updatePlace` sets a status from `MODERATED_PLACE_STATUSES` (including `removed`) or a `verificationState`, and resolves with nothing.
- `verifyCapability` asserts at the `oxy_verified` tier; the value is checked against the key's kind before sending.
- `revisions` is the full history with the account and person behind each change, unlike the public `places.revisions`.

## Duplicates and reports

```ts
const candidates = await goway.moderation.duplicates(); // state 'open' by default
for (const candidate of candidates.items) {
  await goway.moderation.resolveDuplicate(candidate.id, { decision: 'merge', survivorPlaceId: candidate.placeId });
}

const reports = await goway.moderation.reports(); // state 'open' by default
for (const report of reports.items) {
  await goway.moderation.resolveReport(report.id, { resolution: 'dismissed' });
}
```

Merging makes the other place answer `GoWayGoneError` with `mergedInto` pointing at the survivor. `{ decision: 'reject' }` keeps both. A report is resolved `actioned` or `dismissed`; act on it through the other moderation calls.

## Gallery and reviews

```ts
const media = await goway.moderation.media('gw_place_01H8', { state: 'visible' });
await goway.moderation.moderateMedia('gw_place_01H8', 'media_id', { state: 'hidden' });

const reviews = await goway.moderation.reviews('gw_place_01H8', { status: 'published' });
await goway.moderation.moderateReview('gw_place_01H8', 'review_id', { status: 'hidden' });
await goway.moderation.removeReviewReply('gw_place_01H8', 'review_id');
```

Hiding is reversible (`MODERATED_PLACE_MEDIA_STATES`, `MODERATED_PLACE_REVIEW_STATUSES`). A place's rating follows its published reviews.

## Categories

```ts
const all = await goway.moderation.categories(); // deprecated ones included, with position and OSM tags

await goway.moderation.createCategory({
  key: 'food.ice_cream',
  icon: 'restaurant',
  labels: { en: 'Ice cream' },
  // see CategoryCreateInput for position and osmTags
});
await goway.moderation.setCategoryLabel('food.ice_cream', 'es', { label: 'Heladería' });
await goway.moderation.updateCategory('food.ice_cream', { status: 'deprecated' });
```

A key never changes: a rename is a new category and the old one `deprecated`. `labels.en` is required and cannot be removed.

## See also

- [API reference: `client.moderation`](../api-reference/index.md#clientmoderation-gowaymoderationapi)
