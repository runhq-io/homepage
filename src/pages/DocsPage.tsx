import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Navbar, Footer } from '../components/chrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { useT, useLocale, useLocalePath } from '../i18n/context';
import { GROUP_LABEL, GROUP_ORDER, PAGES, REDIRECTS } from '../docs/registry';
import type { DocPage, Group } from '../docs/types';
import { DOCS_STYLES } from '../docs/styles';

// The docs shell: sidebar, page body, "On this page" list, prev/next and help.
// Page content lives in src/docs/pages/*, registered in src/docs/registry.ts.
//
// The pages are English-only for now. /ko/docs renders the same pages with a
// short note, and the chrome (sidebar labels, buttons) is translated.

const DOCS_T = {
  en: {
    crumbsDocs: 'Docs',
    crumbsNotFound: 'Not found',
    onThisPage: 'On this page',
    tocMeta: 'Updated October 2026',
    searchPlaceholder: 'Filter docs…',
    searchClear: 'Clear',
    browse: 'Browse the docs',
    prevLabel: 'Previous',
    nextLabel: 'Next',
    helpH: 'Need a hand?',
    helpP: 'We answer on weekdays, usually within a few hours.',
    helpOpenChat: 'Contact us',
    helpEmail: 'Email support →',
    notFoundH1: "That page doesn't exist.",
    notFoundLedePre: 'Try the ',
    notFoundLedeLink: 'docs home',
    notFoundLedeSuffix: ' or filter the sidebar.',
    localeNote: '',
  },
  ko: {
    crumbsDocs: '문서',
    crumbsNotFound: '찾을 수 없음',
    onThisPage: '이 페이지',
    tocMeta: '2026년 10월 업데이트',
    searchPlaceholder: '문서 검색…',
    searchClear: '지우기',
    browse: '문서 둘러보기',
    prevLabel: '이전',
    nextLabel: '다음',
    helpH: '도움이 필요하신가요?',
    helpP: '평일에는 보통 몇 시간 안에 답변드립니다.',
    helpOpenChat: '문의하기',
    helpEmail: '이메일 문의 →',
    notFoundH1: '해당 페이지를 찾을 수 없습니다.',
    notFoundLedePre: '',
    notFoundLedeLink: '문서 홈',
    notFoundLedeSuffix: '으로 이동하거나 사이드바에서 검색하세요.',
    localeNote: '새 문서는 현재 영어로만 제공됩니다. 한국어 번역은 곧 추가됩니다.',
  },
} as const;

function groupPages(pages: DocPage[]) {
  const groups = new Map<Group, DocPage[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const p of pages) groups.get(p.group)!.push(p);
  return groups;
}

/** Plain text of a page's title, lede and keywords, for the sidebar filter. */
function searchText(p: DocPage): string {
  const lede = typeof p.lede === 'string' ? p.lede : '';
  return [p.title, lede, ...(p.keywords ?? []), ...p.sections.map((s) => s.heading)].join(' ').toLowerCase();
}

function PrevNext({ idx }: { idx: number }) {
  const t = useT(DOCS_T);
  const lp = useLocalePath();
  const prev = idx > 0 ? PAGES[idx - 1] : null;
  const next = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav className="rhpd-prevnext">
      {prev ? (
        <Link to={lp(prev.path)} className="rhpd-pn rhpd-pn-prev">
          <span className="rhpd-pn-arrow">←</span>
          <span>
            <span className="rhpd-pn-kicker mono">{t.prevLabel}</span>
            <span className="rhpd-pn-title">{prev.title}</span>
          </span>
        </Link>
      ) : <span />}
      {next ? (
        <Link to={lp(next.path)} className="rhpd-pn rhpd-pn-next">
          <span>
            <span className="rhpd-pn-kicker mono">{t.nextLabel}</span>
            <span className="rhpd-pn-title">{next.title}</span>
          </span>
          <span className="rhpd-pn-arrow">→</span>
        </Link>
      ) : <span />}
    </nav>
  );
}

function HelpBlock() {
  const t = useT(DOCS_T);
  return (
    <div className="rhpd-help">
      <div>
        <div className="rhpd-help-h">{t.helpH}</div>
        <p className="rhpd-help-p">{t.helpP}</p>
      </div>
      <div className="rhpd-help-r">
        <TalkToUsButton className="rhp-btn-ghost" cta="docs_help">{t.helpOpenChat}</TalkToUsButton>
        <a className="rhp-btn-primary" href="mailto:admin@runhq.io">{t.helpEmail}</a>
      </div>
    </div>
  );
}

function Sidebar({ currentPath }: { currentPath: string }) {
  const t = useT(DOCS_T);
  const locale = useLocale();
  const lp = useLocalePath();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupPages(PAGES), []);
  const q = query.trim().toLowerCase();

  // On mobile the sidebar is collapsed; close it after navigating.
  useEffect(() => setOpen(false), [currentPath]);

  return (
    <aside className={`rhpd-side ${open ? 'rhpd-side-open' : ''}`}>
      <button type="button" className="rhpd-side-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t.browse} <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <div className="rhpd-side-body">
        <div className="rhpd-side-search">
          <span>⌕</span>
          <input placeholder={t.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="rhpd-side-clear" onClick={() => setQuery('')} aria-label={t.searchClear}>×</button>}
        </div>
        <nav className="rhpd-side-nav">
          {GROUP_ORDER.map((g) => {
            const items = (groups.get(g) ?? []).filter((p) => !q || searchText(p).includes(q));
            if (items.length === 0) return null;
            return (
              <div key={g} className="rhpd-side-sec">
                <div className="rhpd-side-h">{GROUP_LABEL[locale][g]}</div>
                {items.map((p) => (
                  <Link key={p.path} to={lp(p.path)} className={`rhpd-side-i ${p.path === currentPath ? 'rhpd-side-on' : ''}`}>
                    {p.title}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

function Toc({ page, activeId }: { page: DocPage; activeId: string | null }) {
  const t = useT(DOCS_T);
  if (page.sections.length === 0) return null;
  return (
    <aside className="rhpd-toc">
      <div className="rhpd-toc-h mono">{t.onThisPage}</div>
      {page.sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className={`rhpd-toc-i ${activeId === s.id ? 'rhpd-toc-on' : ''}`}>
          {s.heading}
        </a>
      ))}
      <div className="rhpd-toc-meta mono">{t.tocMeta}</div>
    </aside>
  );
}

function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  useEffect(() => {
    setActive(ids[0] ?? null);
    if (ids.length === 0) return;
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}

/** Scroll to #hash after a client-side navigation (the browser only does it on hard loads). */
function useHashScroll(path: string) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView();
  }, [path, hash]);
}

export default function DocsPage() {
  const loc = useLocation();
  const locale = useLocale();
  const lp = useLocalePath();
  const t = useT(DOCS_T);

  // Strip the /ko prefix and any trailing slash before matching the registry.
  const path = loc.pathname.replace(/^\/ko(?=\/|$)/, '').replace(/\/+$/, '') || '/docs';
  const idx = PAGES.findIndex((p) => p.path === path);
  const page = idx >= 0 ? PAGES[idx] : null;
  const activeId = useActiveSection(page?.sections.map((s) => s.id) ?? []);
  useHashScroll(path);

  useEffect(() => {
    const prev = document.title;
    document.title = page ? `${page.title} · RunHQ Docs` : 'RunHQ Docs';
    return () => { document.title = prev; };
  }, [page]);

  // Pages from the previous docs keep working: send them to their new home.
  const moved = REDIRECTS[path];
  if (!page && moved) return <Navigate to={lp(moved)} replace />;

  return (
    <div className="rhp-root rhpd-root">
      <style>{DOCS_STYLES}</style>
      <Navbar active="docs" />

      <div className="rhpd-shell">
        <Sidebar currentPath={path} />

        <main className="rhpd-main">
          {page ? (
            <>
              <div className="rhpd-crumbs mono">
                <Link to={lp('/docs')}>{t.crumbsDocs}</Link>
                <span>/</span>
                <span>{GROUP_LABEL[locale][page.group]}</span>
                <span>/</span>
                <span className="rhpd-cur">{page.title}</span>
              </div>

              <h1 className="rhpd-h1">{page.title}</h1>
              {t.localeNote && <p className="rhpd-locale-note" lang="ko">{t.localeNote}</p>}
              {page.lede && <p className="rhpd-lede">{page.lede}</p>}

              {page.hero}

              {page.sections.map((s) => (
                <section key={s.id} className="rhpd-sec">
                  <h2 className="rhpd-h2" id={s.id}>{s.heading}</h2>
                  {s.body}
                </section>
              ))}

              <PrevNext idx={idx} />
              <HelpBlock />
            </>
          ) : (
            <div className="rhpd-404">
              <div className="rhpd-crumbs mono">
                <Link to={lp('/docs')}>{t.crumbsDocs}</Link>
                <span>/</span>
                <span className="rhpd-cur">{t.crumbsNotFound}</span>
              </div>
              <h1 className="rhpd-h1">{t.notFoundH1}</h1>
              <p className="rhpd-lede">{t.notFoundLedePre}<Link className="rhpd-link" to={lp('/docs')}>{t.notFoundLedeLink}</Link>{t.notFoundLedeSuffix}</p>
            </div>
          )}
        </main>

        {page && <Toc page={page} activeId={activeId} />}
      </div>

      <Footer />
    </div>
  );
}
