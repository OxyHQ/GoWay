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

interface I18nValue {
  locale: string;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const full = typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : 'en-US';
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
