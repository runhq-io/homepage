import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT, useLocalePath } from '../i18n/context';
import {
  analyticsEnabled,
  storedConsent,
  setAnalyticsConsent,
  CONSENT_KEY,
  CONSENT_EVENT,
} from '../analytics';

// Show the bar only while analytics is configured and the visitor is undecided.
function shouldShow(): boolean {
  return analyticsEnabled() && storedConsent() === null;
}

const COPY = {
  en: {
    text: 'We use analytics cookies to understand how visitors use our site. Nothing is collected until you accept.',
    privacy: 'Privacy Policy',
    accept: 'Accept',
    decline: 'Decline',
  },
  ko: {
    text: '방문자가 사이트를 어떻게 사용하는지 파악하기 위해 분석 쿠키를 사용합니다. 동의하기 전에는 아무것도 수집하지 않습니다.',
    privacy: '개인정보 처리방침',
    accept: '동의',
    decline: '거부',
  },
} as const;

// Cookie-consent bar. Renders only when analytics is configured for this build
// and the visitor hasn't chosen yet; the choice is persisted and gates GA.
export function ConsentBanner() {
  const t = useT(COPY);
  const localePath = useLocalePath();
  const [visible, setVisible] = useState(shouldShow);

  // Re-evaluate visibility when consent changes elsewhere: another tab
  // (native 'storage' event) or the privacy page in this tab (CONSENT_EVENT).
  // Without this the initializer would only run once and the banner could not
  // reappear after consent is cleared.
  useEffect(() => {
    const sync = () => setVisible(shouldShow());
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONSENT_KEY || e.key === null) sync();
    };
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  if (!visible) return null;

  const choose = (granted: boolean) => {
    setAnalyticsConsent(granted);
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 1000,
        margin: '0 auto',
        maxWidth: 640,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 16,
        padding: '16px 20px',
        background: 'var(--rhw-surface)',
        color: 'var(--rhw-ink-soft)',
        border: '1px solid var(--rhw-line)',
        borderRadius: 12,
        boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <p style={{ margin: 0, flex: '1 1 260px' }}>
        {t.text}{' '}
        <Link
          to={localePath('/privacy')}
          style={{ color: 'var(--rhw-accent)', textDecoration: 'underline' }}
        >
          {t.privacy}
        </Link>
      </p>
      <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
        <button
          type="button"
          onClick={() => choose(false)}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid var(--rhw-line)',
            background: 'transparent',
            color: 'var(--rhw-ink-soft)',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {t.decline}
        </button>
        <button
          type="button"
          onClick={() => choose(true)}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid var(--rhw-accent)',
            background: 'var(--rhw-accent)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t.accept}
        </button>
      </div>
    </div>
  );
}
