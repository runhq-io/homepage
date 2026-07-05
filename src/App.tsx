import { useEffect } from 'react';
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
        </Routes>
        <ConsentBanner />
      </LocaleProvider>
    </BrowserRouter>
  );
}

export default App;
