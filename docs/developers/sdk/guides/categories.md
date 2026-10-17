# Categories

GoWay files places under a taxonomy of dotted category keys (`food`, `food.cafe`, `transport.rail_station`). The taxonomy is data on the server and changes without an SDK release, so read it with `client.categories.list()` and index it with `categoryTaxonomy` rather than keeping your own copy.

## Load the taxonomy

```ts
import { categoryTaxonomy, createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();
const page = await goway.categories.list({ locale: 'es' });
const taxonomy = categoryTaxonomy(page.items);
```

`list` needs no account and answers every category in one page, depth-first with siblings in presentation order. Each `Category` has:

- `key`: immutable; a rename is a new key;
- `parent`: the parent key, or `null` for a root;
- `icon`: a provider-neutral glyph key from `CATEGORY_ICONS` (map it to your own icon set);
- `status`: `active`, or `deprecated` (still on places that carry it, never added to new ones);
- `label`: resolved for the requested `locale` (English when absent or unmatched);
- `labels`: every language GoWay holds, keyed by language tag, `en` always present.

## Label and expand keys

```ts
for (const key of place.categories) {
  console.log(taxonomy.label(key, 'es'));
}

taxonomy.of('food.cafe');         // the Category, or undefined
taxonomy.descendants('food');     // 'food' and every key below it; [] for a key the list lacks
```

`taxonomy.label` returns the key itself for a key the list does not hold.

`categoryParent('food.cafe')` (`'food'`) and `categoryRoot('food.cafe')` (`'food'`) work from the key alone, without the list.

`place.categories` is ordered most specific first. A key the list does not hold is still a key: show it as is.

## Filter by category

`places.nearby`, `places.inBounds` and `search.query` take `categories: string[]`. The filter is a disjunction and includes descendants: `['food']` matches cafés and restaurants. A key that is not a category is a `GoWayValidationError` from the API.

```ts
const page = await goway.places.nearby({
  latitude: 41.3874,
  longitude: 2.1686,
  radiusMeters: 500,
  categories: ['food.cafe', 'food.bakery'],
});
```

Category keys follow `CATEGORY_KEY_PATTERN` and are at most `MAX_CATEGORY_KEY_LENGTH` characters; the SDK checks the shape before sending.

## Editing the taxonomy

Creating, relabelling and deprecating categories are moderation operations (`client.moderation.createCategory`, `updateCategory`, `setCategoryLabel`, `removeCategoryLabel`) for GoWay operators only. See [Moderation](./moderation.md).

## See also

- [Places](./places.md)
- [API reference: `client.categories`](../api-reference/index.md#clientcategories-gowaycategoriesapi)
