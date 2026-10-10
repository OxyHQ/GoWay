import { matchLanguageTag, normalizeLanguageTag } from '@goway.to/sdk';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { PRODUCTS_EN, PRODUCTS_ES } from './messages/products';
import { STREET3D_EN, STREET3D_ES } from './messages/street3d';

// Minimal, dependency-free i18n. Synchronous by design — no suspense — so it is
// safe to mount at the root of the provider tree. Swap in i18next later if the
// app grows to need pluralization / interpolation / lazy locale loading.

type Messages = Record<string, string>;

const en: Messages = {
  'map.title': 'GoWay',
  'map.signIn': 'Sign in',
  'map.myLocation': 'My location',
  // The "why" in the permission's own words, shown BEFORE the system prompt —
  // the contextual explanation issue #7 asks for, attached to the control that
  // triggers it rather than to a screen in front of the map.
  'map.myLocationHint': 'Centres the map on you. GoWay asks for location only when you tap this.',
  'map.locationDenied': 'Location is off for GoWay. You can still search and browse the map.',
  'map.resetNorth': 'Reset to north',
  ...STREET3D_EN,
  ...PRODUCTS_EN,
};

const es: Messages = {
  'map.title': 'GoWay',
  'map.signIn': 'Iniciar sesión',
  'map.myLocation': 'Mi ubicación',
  'map.myLocationHint': 'Centra el mapa en ti. GoWay solo pide tu ubicación cuando tocas aquí.',
  'map.locationDenied':
    'La ubicación está desactivada para GoWay. Puedes seguir buscando y explorando el mapa.',
  'map.resetNorth': 'Orientar al norte',
  ...STREET3D_ES,
  ...PRODUCTS_ES,
};

const locales: Record<string, Messages> = { en, es };

/** Interpolation values for `{name}` placeholders. */
export type MessageValues = Readonly<Record<string, string | number>>;

/** Replace `{name}` placeholders. An unknown placeholder is left as written. */
export function formatMessage(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/**
 * The device's language tag, outside React.
 *
 * `LocaleProvider` is a hook and `lib/goway/client.ts` is a module-level
 * constant, so the SDK client cannot read the locale through the context. Both
 * read it from here instead, which is what keeps the language the map's labels
 * are fetched in and the language its chrome is written in from drifting apart.
 *
 * It is the FULL tag (`es-MX`), not the base: GoWay resolves a place name
 * against the region first and falls back to the bare language itself, so
 * truncating here would throw away the more specific answer.
 */
export function deviceLocale(): string {
  const resolved =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : 'en-US';
  // `resolvedOptions().locale` can carry an extension sequence — `en-US-u-ca-
  // gregory` on some engines — which is a valid BCP 47 tag and not a name key.
  // Everything from the first singleton subtag on is extension or private use,
  // so it goes, and the script and region before it stay: `zh-Hant-TW-u-nu-
  // hanidec` must still read as Traditional Chinese, never as a bare `zh` the
  // label matcher would serve Simplified. Falling back to the bare language
  // keeps SOMETHING when the rest is not a tag, and this function must never
  // return a tag the SDK refuses: it is read at module load, and a throw there
  // is a blank app rather than an English one.
  const withoutExtensions = resolved.replace(/[-_][A-Za-z0-9](?=[-_]|$)[\s\S]*$/, '');
  return (
    normalizeLanguageTag(withoutExtensions) ??
    normalizeLanguageTag(resolved.split(/[-_]/)[0]) ??
    'en'
  );
}

interface I18nValue {
  locale: string;
  t: (key: string, values?: MessageValues) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const full = deviceLocale();
    // The table is chosen the way a label is (`matchLanguageTag`, whole tag),
    // so `es-MX` reads `es` and the chrome never disagrees with the labels.
    const messages = locales[matchLanguageTag(Object.keys(locales), full) ?? 'en'] ?? en;
    // A key missing from a translation falls back to English, never to the
    // raw key: a half-translated locale reads as English, not as `map.title`.
    return {
      locale: full,
      t: (key, values) => formatMessage(messages[key] ?? en[key] ?? key, values),
    };
  }, []);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useTranslation must be used within <LocaleProvider>');
  }
  return ctx;
}
