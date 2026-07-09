import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'en' | 'ko';

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
];

export const LOCALE_KEY = 'runhq_locale';

/**
 * Locale is a **user preference**, not a URL segment.
 *
 * It used to be a path prefix (`/ko/pricing`). That put locales and project
 * slugs in the same namespace: the board catch-all `/:slug` cannot tell whether
 * a lone `/ko` is a language or a project, and every attempt to disambiguate it
 * was a guard bolted onto a guard. Path-based locale exists to give crawlers a
 * distinct URL per language, and this site emits no `hreflang`, no canonical
 * link, and no sitemap — so the prefix paid the collision and bought nothing.
 *
 * Now: one URL per page. The locale comes from `localStorage`, defaulting to the
 * browser's language, and the switcher writes it. Legacy `/ko/*` links redirect
 * to their unprefixed path (see App.tsx) so URLs already shared keep working.
 */

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({ locale: 'en', setLocale: () => {} });

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'ko';
}

/** The persisted preference, or null when unset / unreadable (private mode). */
export function readStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Explicit preference wins; otherwise fall back to the browser's language. */
export function detectLocale(navigatorLanguage: string = ''): Locale {
  const stored = readStoredLocale();
  if (stored) return stored;
  return navigatorLanguage.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    detectLocale(typeof navigator !== 'undefined' ? navigator.language || '' : ''),
  );

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode, etc.) — the switch still
      // applies for this session, it just won't persist.
    }
    setLocaleState(next);
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

export function useT<T extends Record<Locale, unknown>>(content: T): T[Locale] {
  const locale = useLocale();
  return content[locale];
}

/**
 * Switch language in place. No navigation — the URL does not encode the locale,
 * so the current page simply re-renders in the new language.
 */
export function useLocaleSwitch() {
  return useContext(LocaleContext).setLocale;
}
