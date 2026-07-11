import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { trackPageview } from './analytics';
import HomePage from './pages/HomePage';
import ProductsPage from './pages/ProductsPage';
import PricingPage from './pages/PricingPage';
import DocsPage from './pages/DocsPage';
import VisualPage from './pages/VisualPage';
import AboutPage from './pages/AboutPage';
import PrivacyPage from './pages/PrivacyPage';
import TermsPage from './pages/TermsPage';
import { LocaleProvider, BrowserDetector } from './i18n/context';
import { ConsentBanner } from './components/ConsentBanner';
import RunHQWidget from './components/RunHQWidget';
import { TalkToUsProvider } from './components/TalkToUsModal';

// Code-split: the widget board (and its 404 fallback) load their own chunk so a
// shared `/:slug` board never pulls the marketing/Three.js bundle, and the
// marketing pages never pull the board. See BoardPage for the design.
const BoardPage = lazy(() => import('./pages/BoardPage'));
// Same chunk as BoardPage — it is the board route's locale-prefix repair hatch.
const LocalizedBoardRedirect = lazy(() =>
  import('./pages/BoardPage').then((m) => ({ default: m.LocalizedBoardRedirect })),
);

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Report client-side navigations to GA. This is a single-page app, so only the
// first hard load produces a document request — every move after that (marketing
// nav, and the board's per-tab sub-paths like /arrr/tickets) is a pushState that
// GA would otherwise never see.
function RouteChangeTracker() {
  const { pathname, search } = useLocation();
  const reportedFirst = useRef(false);
  useEffect(() => {
    // gtag's `config` already reported the initial page_view for the hard load;
    // reporting it again here would double-count every landing.
    if (!reportedFirst.current) {
      reportedFirst.current = true;
      return;
    }
    trackPageview(`${pathname}${search}`);
  }, [pathname, search]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <LocaleProvider>
        <BrowserDetector />
        <ScrollToTop />
        <RouteChangeTracker />
        {/* Floating RunHQ bug-report launcher on every marketing page (stays out
            of the way on the /:slug full-page board — see RunHQWidget). */}
        <RunHQWidget />
        <TalkToUsProvider>
        <Suspense fallback={<div style={{ minHeight: '100vh', background: '#0b0b0f' }} />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/docs/*" element={<DocsPage />} />
            <Route path="/visual" element={<VisualPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />

            <Route path="/ko" element={<HomePage />} />
            <Route path="/ko/products" element={<ProductsPage />} />
            <Route path="/ko/pricing" element={<PricingPage />} />
            <Route path="/ko/docs/*" element={<DocsPage />} />
            <Route path="/ko/visual" element={<VisualPage />} />
            <Route path="/ko/about" element={<AboutPage />} />
            <Route path="/ko/privacy" element={<PrivacyPage />} />
            <Route path="/ko/terms" element={<TermsPage />} />

            {/* Boards have no Korean twin, so /ko/<slug> is never a URL we mint —
                but the locale auto-detector used to produce (and visitors shared)
                them. Redirect back onto the canonical board instead of resolving
                slug `ko` and 404ing. Declared /ko/* routes above win first. */}
            <Route path="/ko/:slug/*" element={<LocalizedBoardRedirect />} />

            {/* Catch-all: full-page widget board at www.runhq.io/:slug, plus its
                per-tab sub-paths (/:slug/tickets, /:slug/deploys, /:slug/my-tickets)
                — the trailing splat keeps BoardPage mounted while the widget owns
                that segment (see be/public/widget.js tab routing). MUST stay last so
                every declared marketing path wins first. Non-project / reserved
                slugs render a 404 from within BoardPage. */}
            <Route path="/:slug/*" element={<BoardPage />} />
          </Routes>
        </Suspense>
        </TalkToUsProvider>
        <ConsentBanner />
      </LocaleProvider>
    </BrowserRouter>
  );
}

export default App;
