import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLocalePath } from '../i18n/context';
import ImageLightbox from '../components/ImageLightbox';

// Small building blocks for docs pages. Content files compose these so page
// markup stays short and every page looks the same.

export const P = ({ children }: { children: ReactNode }) => <p className="rhpd-p">{children}</p>;
export const Em = ({ children }: { children: ReactNode }) => <strong className="rhpd-em">{children}</strong>;
export const UL = ({ children }: { children: ReactNode }) => <ul className="rhpd-ul">{children}</ul>;
export const OL = ({ children }: { children: ReactNode }) => <ol className="rhpd-ol">{children}</ol>;
export const Steps = ({ children }: { children: ReactNode }) => <ol className="rhpd-steps">{children}</ol>;
export const H3 = ({ children }: { children: ReactNode }) => <h3 className="rhpd-h3">{children}</h3>;

/** A keyboard key or chord, e.g. <Kbd>Ctrl+Shift+J</Kbd>. */
export const Kbd = ({ children }: { children: string }) => (
  <span className="rhpd-kbd-group">
    {children.split('+').map((k, i) => (
      <span key={i}>
        {i > 0 && <span className="rhpd-kbd-plus">+</span>}
        <kbd className="rhpd-kbd">{k}</kbd>
      </span>
    ))}
  </span>
);

/** The exact text of something in the app: a button, tab, menu item or field. */
export const UI = ({ children }: { children: ReactNode }) => <span className="rhpd-ui">{children}</span>;

/** Internal docs link. Takes an unprefixed path and adds the locale prefix. */
export const NL = ({ to, children }: { to: string; children: ReactNode }) => {
  const lp = useLocalePath();
  return <Link className="rhpd-link" to={lp(to)}>{children}</Link>;
};

/** External link, opened in a new tab. */
export const XL = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="rhpd-link" href={href} target="_blank" rel="noreferrer">{children}</a>
);

export const Code = ({ title, children }: { title?: string; children: string }) => (
  <div className="rhpd-code-card">
    {title && <div className="rhpd-code-h">{title}</div>}
    <pre className="rhpd-code">{children}</pre>
  </div>
);

export const Callout = ({ kind = 'tip', children }: { kind?: 'tip' | 'warn'; children: ReactNode }) => (
  <div className={`rhpd-note rhpd-note-${kind}`}>
    <span className="rhpd-note-mark mono">{kind === 'tip' ? 'Tip' : 'Heads up'}</span>
    <div>{children}</div>
  </div>
);

/**
 * A screenshot of the app. Images live in public/docs/img/<name>.webp and are
 * captured at 2x from a demo workspace, so they stay sharp on retina screens.
 * Click to open full size.
 */
export function Shot({ name, alt, caption, narrow }: { name: string; alt: string; caption?: ReactNode; narrow?: boolean }) {
  const [open, setOpen] = useState(false);
  const src = `/docs/img/${name}.webp`;
  return (
    <figure className={`rhpd-shot ${narrow ? 'rhpd-shot-narrow' : ''}`}>
      <button type="button" className="rhpd-shot-btn" onClick={() => setOpen(true)} aria-label={`Enlarge: ${alt}`}>
        <img src={src} alt={alt} loading="lazy" decoding="async" />
      </button>
      {caption && <figcaption className="rhpd-shot-cap">{caption}</figcaption>}
      {open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </figure>
  );
}

/** Ticket status chip, matching the colours the app uses. */
export const Status = ({ children, kind }: { children: ReactNode; kind: 'pending' | 'progress' | 'review' | 'done' | 'deployed' | 'cancelled' }) => (
  <span className={`rhpd-pill rhpd-pill-${kind}`}>{children}</span>
);

/** A grid of link cards (used on the welcome page). */
export const Cards = ({ items }: { items: { to: string; tag: string; title: string; body: string }[] }) => {
  const lp = useLocalePath();
  return (
    <div className="rhpd-cards">
      {items.map((c) => (
        <Link key={c.to} className="rhpd-card" to={lp(c.to)}>
          <div className="rhpd-card-tag mono">{c.tag}</div>
          <div className="rhpd-card-t">{c.title}</div>
          <div className="rhpd-card-d">{c.body}</div>
          <div className="rhpd-card-link">Read →</div>
        </Link>
      ))}
    </div>
  );
};

/** Two-column reference table. */
export const Table = ({ head, rows }: { head: [string, string] | [string, string, string]; rows: ReactNode[][] }) => (
  <div className="rhpd-table-wrap">
    <table className="rhpd-table">
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  </div>
);
