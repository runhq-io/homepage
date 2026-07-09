import { createContext, useContext, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isBoardRoute } from '../widget';

export type Locale = 'en' | 'ko';

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
];

const LocaleContext = createContext<Locale>('en');

const LOCALE_KEY = 'runhq_locale';
const KO_PREFIX = '/ko';

/**
 * The `/ko` prefix is a **marketing-site** concept: only the routes declared in
 * App.tsx have a Korean twin (`/pricing` → `/ko/pricing`). The full-page widget
 * board served by the `/:slug/*` catch-all has none — it renders the customer's
 * board, not our copy. Prefixing one yields `/ko/<slug>`, which the router reads
 * as slug `ko` (a reserved slug) and renders as a 404.
 *
 * So no locale move — automatic (BrowserDetector) or user-driven (the language
 * switcher) — may ever carry a board URL under `/ko`.
 */
export function isLocalizablePath(pathname: string): boolean {
  return !isBoardRoute(pathname);
}

export function pathForLocale(currentPath: string, targetLocale: Locale): string {
  const stripped = currentPath.startsWith(KO_PREFIX)
    ? currentPath.slice(KO_PREFIX.length) || '/'
    : currentPath;
  if (targetLocale === 'ko' && isLocalizablePath(stripped)) {
    return stripped === '/' ? KO_PREFIX : `${KO_PREFIX}${stripped}`;
  }
  return stripped;
}

export function localeFromPath(pathname: string): Locale {
  if (pathname === KO_PREFIX || pathname.startsWith(`${KO_PREFIX}/`)) return 'ko';
  return 'en';
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const locale = localeFromPath(pathname);
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT<T extends Record<Locale, unknown>>(content: T): T[Locale] {
  const locale = useLocale();
  return content[locale];
}

export function useLocalePath() {
  const locale = useLocale();
  return (path: string): string => {
    if (locale !== 'ko') return path;
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('mailto:')) return path;
    if (path.startsWith('/') && !isLocalizablePath(path)) return path;
    if (path === '/') return KO_PREFIX;
    if (path.startsWith(KO_PREFIX)) return path;
    return `${KO_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  };
}

export function useLocaleSwitch() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  return (target: Locale) => {
    try {
      localStorage.setItem(LOCALE_KEY, target);
    } catch {
      // localStorage may be unavailable (private mode, etc.) — fail silently.
    }
    navigate(`${pathForLocale(pathname, target)}${search}${hash}`);
  };
}

export function BrowserDetector() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    // A shared board link (www.runhq.io/arrr) must open the board for everyone,
    // whatever their browser language. Sending a Korean visitor to /ko/arrr made
    // the router resolve slug `ko` and render a 404 — see isLocalizablePath.
    if (!isLocalizablePath(pathname)) return;

    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LOCALE_KEY);
    } catch {
      stored = null;
    }
    const onKoPath = localeFromPath(pathname) === 'ko';

    if (stored === 'ko' && !onKoPath) {
      navigate(`${pathForLocale(pathname, 'ko')}${search}${hash}`, { replace: true });
      return;
    }
    if (!stored && !onKoPath) {
      const lang = typeof navigator !== 'undefined' ? navigator.language || '' : '';
      if (lang.toLowerCase().startsWith('ko')) {
        navigate(`${pathForLocale(pathname, 'ko')}${search}${hash}`, { replace: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
