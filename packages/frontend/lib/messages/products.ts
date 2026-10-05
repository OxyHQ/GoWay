/**
 * "Products at this store" strings, per locale.
 *
 * Kept beside `lib/i18n.tsx` like the Street 3D strings: the section is a
 * feature's, not the map's. `__tests__/products.test.ts` asserts every locale
 * carries every key with the same placeholders, so a new string cannot ship
 * half-translated.
 *
 * A count picks `.one` or `.other` (`pluralKey` in `lib/mercaria/presentation.ts`).
 * Store names and product titles are Mercaria's and arrive as `{store}` and
 * `{product}`, never translated here.
 */

export const PRODUCTS_EN: Record<string, string> = {
  'products.heading.one': 'Products at this store',
  'products.heading.other': 'Products at stores here',
  'products.loading': 'Loading products',
  'products.retry.message': "Products from Mercaria couldn't load right now.",
  'products.retry.button': 'Try again',
  'products.retry.trying': 'Trying…',
  'products.store.onMercaria': 'On Mercaria',
  'products.store.empty': 'Nothing confirmed in stock here right now.',
  'products.store.seeAll': 'See all at {store}',
  'products.store.seeAllLabel': 'See all at {store}, on Mercaria',
  'products.tile.label': '{product}. Opens on Mercaria.',
  'products.availability.in_stock': 'In stock',
  'products.availability.low_stock': 'Low stock',
  'products.availability.out_of_stock': 'Out of stock',
  'products.quantity.one': '{count} left',
  'products.quantity.other': '{count} left',
  'products.confirmed.now': 'Stock confirmed just now',
  'products.confirmed.minutes.one': 'Stock confirmed {count} minute ago',
  'products.confirmed.minutes.other': 'Stock confirmed {count} minutes ago',
  'products.confirmed.hours.one': 'Stock confirmed {count} hour ago',
  'products.confirmed.hours.other': 'Stock confirmed {count} hours ago',
  'products.confirmed.days.one': 'Stock confirmed {count} day ago',
  'products.confirmed.days.other': 'Stock confirmed {count} days ago',
};

export const PRODUCTS_ES: Record<string, string> = {
  'products.heading.one': 'Productos en esta tienda',
  'products.heading.other': 'Productos en las tiendas de aquí',
  'products.loading': 'Cargando productos',
  'products.retry.message': 'Ahora mismo no se han podido cargar los productos de Mercaria.',
  'products.retry.button': 'Reintentar',
  'products.retry.trying': 'Reintentando…',
  'products.store.onMercaria': 'En Mercaria',
  'products.store.empty': 'Ahora mismo no hay nada con stock confirmado aquí.',
  'products.store.seeAll': 'Ver todo en {store}',
  'products.store.seeAllLabel': 'Ver todo en {store}, en Mercaria',
  'products.tile.label': '{product}. Se abre en Mercaria.',
  'products.availability.in_stock': 'En stock',
  'products.availability.low_stock': 'Pocas unidades',
  'products.availability.out_of_stock': 'Agotado',
  'products.quantity.one': 'Queda {count}',
  'products.quantity.other': 'Quedan {count}',
  'products.confirmed.now': 'Stock confirmado ahora mismo',
  'products.confirmed.minutes.one': 'Stock confirmado hace {count} minuto',
  'products.confirmed.minutes.other': 'Stock confirmado hace {count} minutos',
  'products.confirmed.hours.one': 'Stock confirmado hace {count} hora',
  'products.confirmed.hours.other': 'Stock confirmado hace {count} horas',
  'products.confirmed.days.one': 'Stock confirmado hace {count} día',
  'products.confirmed.days.other': 'Stock confirmado hace {count} días',
};
