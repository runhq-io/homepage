import { Link } from 'react-router-dom';
import { Navbar, Footer } from '../components/chrome';

/**
 * Minimal branded 404. Rendered by BoardPage when a `/:slug` catch-all matches a
 * reserved marketing path (a defensive fallback — declared routes win first) and
 * available as a generic not-found page.
 */
export default function NotFoundPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '6rem 1.5rem',
          gap: '1rem',
        }}
      >
        <p style={{ fontSize: '0.8rem', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6 }}>
          Error · 404
        </p>
        <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', margin: 0 }}>Page not found.</h1>
        <p style={{ maxWidth: '32rem', opacity: 0.75, lineHeight: 1.6 }}>
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <Link
          to="/"
          style={{
            marginTop: '0.5rem',
            padding: '0.65rem 1.25rem',
            borderRadius: '0.6rem',
            background: '#111',
            color: '#fff',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          Back to home
        </Link>
      </main>
      <Footer />
    </div>
  );
}
