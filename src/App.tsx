import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
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

// Code-split: the widget board (and its 404 fallback) load their own chunk so a
// shared `/:slug` board never pulls the marketing/Three.js bundle, and the
// marketing pages never pull the board. See BoardPage for the design.
const BoardPage = lazy(() => import('./pages/BoardPage'));

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <LocaleProvider>
        <BrowserDetector />
        <ScrollToTop />
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

            {/* Catch-all: full-page widget board at www.runhq.io/:slug. MUST stay
                last so every declared marketing path wins first. Non-project /
                reserved slugs render a 404 from within BoardPage. */}
            <Route path="/:slug" element={<BoardPage />} />
          </Routes>
        </Suspense>
        <ConsentBanner />
      </LocaleProvider>
    </BrowserRouter>
  );
}

export default App;
