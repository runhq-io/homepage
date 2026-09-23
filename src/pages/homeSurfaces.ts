/**
 * The home page's Evolve surfaces.
 *
 * Field names are the copy keys and the defaults are picked from HOME_T, so the
 * declared default is always exactly what the page ships. Korean is its own
 * surface (`<key>-ko`): an arm is written in one language, and a run that
 * served English arms to Korean readers would measure the language, not the copy.
 */
import type { Locale } from '../i18n/context';
import { HOME_T } from './homeCopy';

type HomeCopy = (typeof HOME_T)['en'];

export const HERO_FIELDS = [
  'heroH1Line1',
  'heroH1Line2',
  'heroLede',
  'ctaStartFree',
  'ctaWatchDemo',
] as const satisfies readonly (keyof HomeCopy)[];

/** The closing band's heading (two lines) and its lead CTA — the one that opens the lead form. */
export const CLOSING_FIELDS = ['ctaH1', 'ctaH2', 'ctaBtnPrimary'] as const satisfies readonly (keyof HomeCopy)[];

export type HeroFields = { readonly [K in (typeof HERO_FIELDS)[number]]: string };
export type ClosingFields = { readonly [K in (typeof CLOSING_FIELDS)[number]]: string };

function pick<K extends string>(copy: { readonly [P in K]: string }, fields: readonly K[]): { readonly [P in K]: string } {
  const out = {} as { [P in K]: string };
  for (const field of fields) out[field] = copy[field];
  return out;
}

export type HomeSurfaceBase = 'home.hero' | 'home.closing';

export function surfaceKey(base: HomeSurfaceBase, locale: Locale): string {
  return locale === 'ko' ? `${base}-ko` : base;
}

/** Module constants: `useSurface` needs a stable fallback object per surface. */
export const HOME_SURFACES: {
  readonly hero: Readonly<Record<Locale, HeroFields>>;
  readonly closing: Readonly<Record<Locale, ClosingFields>>;
} = {
  hero: { en: pick(HOME_T.en, HERO_FIELDS), ko: pick(HOME_T.ko, HERO_FIELDS) },
  closing: { en: pick(HOME_T.en, CLOSING_FIELDS), ko: pick(HOME_T.ko, CLOSING_FIELDS) },
};
