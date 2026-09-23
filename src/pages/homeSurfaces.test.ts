import { describe, expect, it } from 'vitest';
import { CLOSING_FIELDS, HERO_FIELDS, HOME_SURFACES, surfaceKey } from './homeSurfaces';
import { HOME_T } from './homeCopy';

/**
 * The surfaces' defaults ARE what ships. Evolve compares every arm against the
 * default the page declared, and an adopted winner is served only while the
 * code still ships the default it beat (EvolveServingService adoptedDefaults) —
 * so a default that drifted from the rendered copy by one byte would silently
 * stop a winner serving. These literals are copied from the page on purpose.
 */
describe('home surface defaults', () => {
  it('hero (en) is byte-for-byte the shipped copy', () => {
    expect(HOME_SURFACES.hero.en).toEqual({
      heroH1Line1: 'Signal-to-code.',
      heroH1Line2: 'Ship what users actually need.',
      heroLede: 'RunHQ turns user feedback, telemetry, and support tickets into agent-built PRs — ready to review and ship. Come to work, approve the diff, merge.',
      ctaStartFree: 'Talk to us',
      ctaWatchDemo: 'Watch Demo',
    });
  });

  it('closing (en) is byte-for-byte the shipped copy', () => {
    expect(HOME_SURFACES.closing.en).toEqual({
      ctaH1: 'Stop translating feedback by hand.',
      ctaH2: 'Start shipping it.',
      ctaBtnPrimary: 'Talk to us →',
    });
  });

  it('hero and closing (ko) are byte-for-byte the shipped Korean copy', () => {
    expect(HOME_SURFACES.hero.ko).toEqual({
      heroH1Line1: '시그널에서 코드로.',
      heroH1Line2: '사용자가 실제로 필요한 걸 배포하세요.',
      heroLede: 'RunHQ는 사용자 피드백, 텔레메트리, 지원 티켓을 에이전트가 만든 PR로 바꿔줍니다 — 검토하고 배포할 준비가 된 채로. 출근해서 diff 승인하고 머지하세요.',
      ctaStartFree: '문의하기',
      ctaWatchDemo: '데모 보기',
    });
    expect(HOME_SURFACES.closing.ko).toEqual({
      ctaH1: '피드백을 손으로 옮기는 건 그만.',
      ctaH2: '바로 배포하세요.',
      ctaBtnPrimary: '문의하기 →',
    });
  });

  it('names every field exactly as its copy key, and nothing else', () => {
    expect([...HERO_FIELDS]).toEqual(['heroH1Line1', 'heroH1Line2', 'heroLede', 'ctaStartFree', 'ctaWatchDemo']);
    expect([...CLOSING_FIELDS]).toEqual(['ctaH1', 'ctaH2', 'ctaBtnPrimary']);
    for (const locale of ['en', 'ko'] as const) {
      for (const field of HERO_FIELDS) expect(HOME_SURFACES.hero[locale][field]).toBe(HOME_T[locale][field]);
      for (const field of CLOSING_FIELDS) expect(HOME_SURFACES.closing[locale][field]).toBe(HOME_T[locale][field]);
    }
  });
});

describe('surfaceKey', () => {
  it('gives Korean its own surface, so a run never mixes languages', () => {
    expect(surfaceKey('home.hero', 'en')).toBe('home.hero');
    expect(surfaceKey('home.hero', 'ko')).toBe('home.hero-ko');
    expect(surfaceKey('home.closing', 'en')).toBe('home.closing');
    expect(surfaceKey('home.closing', 'ko')).toBe('home.closing-ko');
  });
});
