import { useState, useRef, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import RunHQPage from './pages/RunHQPage';
import WidgetPage from './pages/WidgetPage';
import ProjectPage from './pages/ProjectPage';
import ProjectTaskPage from './pages/ProjectTaskPage';
import ProjectsPage from './pages/ProjectsPage';
import PricingPage from './pages/PricingPage';
import DocsPage from './pages/DocsPage';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function Layout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const [mobileProductsOpen, setMobileProductsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const isHome = pathname === '/' || pathname === '/agent-automation';

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProductsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (isHome) {
    return (
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/agent-automation" element={<HomePage heroVariant="automate" />} />
      </Routes>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <nav className="border-b border-slate-700/50 backdrop-blur-sm bg-slate-900/50 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link to="/" className="flex items-center gap-2">
                <span className="text-xl font-bold text-white">RunHQ</span>
                <span className="text-xs font-medium text-cyan-400 border border-cyan-400/30 rounded px-1.5 py-0.5">Beta</span>
              </Link>

              {/* Desktop nav links — next to logo */}
              <div className="hidden md:flex items-center gap-6">
                {/* Products dropdown */}
                <div ref={dropdownRef} className="relative">
                  <button
                    onClick={() => setProductsOpen(prev => !prev)}
                    className="flex items-center gap-1 text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    Products
                    <svg className={`w-4 h-4 transition-transform ${productsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {productsOpen && (
                    <div className="absolute top-full left-0 mt-2 w-64 bg-slate-800 border border-slate-700/50 rounded-xl shadow-xl shadow-black/20 overflow-hidden">
                      <Link
                        to="/runhq"
                        onClick={() => setProductsOpen(false)}
                        className="block px-4 py-3 hover:bg-slate-700/50 transition-colors"
                      >
                        <div className="text-white font-medium text-sm">RunHQ</div>
                        <div className="text-slate-400 text-xs mt-0.5">AI agents for your workflows</div>
                      </Link>
                      <Link
                        to="/widget"
                        onClick={() => setProductsOpen(false)}
                        className="block px-4 py-3 hover:bg-slate-700/50 transition-colors border-t border-slate-700/50"
                      >
                        <div className="text-white font-medium text-sm">Widget</div>
                        <div className="text-slate-400 text-xs mt-0.5">Collect feedback, ship faster</div>
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="hidden md:flex items-center">
              <a href="https://app.runhq.io" className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-semibold rounded-lg transition-colors text-sm">
                Login
              </a>
            </div>

            {/* Mobile hamburger */}
            <button
              className="md:hidden text-white p-2"
              onClick={() => setMobileMenuOpen(prev => !prev)}
              aria-label="Toggle menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {mobileMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>

          {/* Mobile menu */}
          {mobileMenuOpen && (
            <div className="md:hidden flex flex-col gap-1 pt-4 pb-2">
              <button
                onClick={() => setMobileProductsOpen(prev => !prev)}
                className="flex items-center justify-between px-3 py-2 text-sm text-slate-300 hover:text-white transition-colors rounded-lg hover:bg-slate-800/50"
              >
                Products
                <svg className={`w-4 h-4 transition-transform ${mobileProductsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {mobileProductsOpen && (
                <div className="ml-4 flex flex-col gap-1">
                  <Link
                    to="/runhq"
                    onClick={() => { setMobileMenuOpen(false); setMobileProductsOpen(false); }}
                    className="px-3 py-2 text-sm text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-800/50"
                  >
                    RunHQ
                  </Link>
                  <Link
                    to="/widget"
                    onClick={() => { setMobileMenuOpen(false); setMobileProductsOpen(false); }}
                    className="px-3 py-2 text-sm text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-800/50"
                  >
                    Widget
                  </Link>
                </div>
              )}

              <a href="https://app.runhq.io" className="mt-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-semibold rounded-lg transition-colors text-sm text-center">
                Login
              </a>
            </div>
          )}
        </div>
      </nav>

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/agent-automation" element={<HomePage heroVariant="automate" />} />
        <Route path="/runhq" element={<RunHQPage />} />
        <Route path="/widget" element={<WidgetPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/project/:slug" element={<ProjectPage />} />
        <Route path="/project/:slug/proposals/:ticketId" element={<ProjectTaskPage />} />
        <Route path="/project/:slug/task/:ticketId" element={<ProjectTaskPage />} />
      </Routes>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Layout />
    </BrowserRouter>
  );
}

export default App;
