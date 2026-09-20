import { normalizeLanguageTag } from '@goway.to/sdk';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

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
};

const locales: Record<string, Messages> = { en };

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
  const resolved = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : 'en-US';
  // `resolvedOptions().locale` can carry an extension sequence — `en-US-u-ca-
  // gregory` on some engines — which is a valid BCP 47 tag and not a name key.
  // Normalizing the whole tag first keeps the region when there is one; falling
  // back to the bare language keeps SOMETHING when there is not, and this
  // function must never return a tag the SDK refuses: it is read at module
  // load, and a throw there is a blank app rather than an English one.
  return (
    normalizeLanguageTag(resolved) ??
    normalizeLanguageTag(resolved.split(/[-_]/)[0]) ??
    'en'
  );
}

interface I18nValue {
  locale: string;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const full = deviceLocale();
    const base = full.split('-')[0];
    const messages = locales[base] ?? en;
    return { locale: full, t: (key) => messages[key] ?? key };
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
