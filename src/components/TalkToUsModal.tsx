import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/context';
import { API_BASE } from '../widget';

// "Talk to us" lead-capture modal. The button opens a dialog that POSTs to the
// RunHQ backend's public POST /api/leads endpoint; submissions surface in the
// admin panel at console.runhq.io/admin/leads.
//
// Client-side hardening mirrors the server (which is the real authority):
//  - Hidden honeypot field ("company") that humans never see.
//  - Required-field + email validation before we bother the network.
//  - Length caps identical to the server, so we never send it junk.
//  - Submit is disabled while in-flight (no double posts).

const LEADS_ENDPOINT = `${API_BASE}/api/leads`;

const LIMITS = {
  name: 200,
  email: 254,
  website: 2048,
  communitySize: 200,
  monthlyRevenue: 200,
} as const;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COPY = {
  en: {
    title: 'Talk to us',
    subtitle: "Tell us about your community and we'll be in touch.",
    name: 'Your name',
    email: 'Your email',
    website: "Your company's website",
    community: 'How many users do you have?',
    communityHint: 'How big is your community?',
    revenue: "What's your monthly revenue?",
    optional: 'optional',
    submit: 'Submit',
    submitting: 'Sending…',
    close: 'Close',
    successTitle: 'Thanks — got it!',
    successBody: "We've received your details and will reach out soon.",
    done: 'Done',
    errName: 'Please enter your name.',
    errEmail: 'Please enter a valid email.',
    errWebsite: 'Please enter your company website.',
    errGeneric: 'Something went wrong.',
    errFallbackPre: 'Please try again, or email us at ',
  },
  ko: {
    title: '문의하기',
    subtitle: '커뮤니티에 대해 알려주시면 곧 연락드리겠습니다.',
    name: '이름',
    email: '이메일',
    website: '회사 웹사이트',
    community: '사용자가 몇 명인가요?',
    communityHint: '커뮤니티 규모는 어느 정도인가요?',
    revenue: '월 매출은 얼마인가요?',
    optional: '선택',
    submit: '보내기',
    submitting: '보내는 중…',
    close: '닫기',
    successTitle: '감사합니다 — 접수되었습니다!',
    successBody: '내용을 받았습니다. 곧 연락드리겠습니다.',
    done: '완료',
    errName: '이름을 입력해 주세요.',
    errEmail: '올바른 이메일을 입력해 주세요.',
    errWebsite: '회사 웹사이트를 입력해 주세요.',
    errGeneric: '문제가 발생했습니다.',
    errFallbackPre: '다시 시도하시거나 다음 이메일로 연락 주세요: ',
  },
} as const;

type Status = 'idle' | 'submitting' | 'success' | 'error';

interface TalkToUsContextValue {
  open: () => void;
}

const TalkToUsContext = createContext<TalkToUsContextValue | null>(null);

export function useTalkToUs(): TalkToUsContextValue {
  const ctx = useContext(TalkToUsContext);
  if (!ctx) throw new Error('useTalkToUs must be used within <TalkToUsProvider>');
  return ctx;
}

/**
 * A CTA styled exactly like the site's existing anchor buttons, but which opens
 * the lead-capture modal instead of navigating. Kept as an <a role="button"> so
 * it inherits the current `.rhw-btn-primary` / `.rhc-cta` styling pixel-for-pixel.
 */
export function TalkToUsButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { open } = useTalkToUs();
  return (
    <a
      className={className}
      href="#talk-to-us"
      role="button"
      onClick={(e) => {
        e.preventDefault();
        open();
      }}
    >
      {children}
    </a>
  );
}

export function TalkToUsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <TalkToUsContext.Provider value={{ open }}>
      {children}
      {isOpen && <TalkToUsModal onClose={close} />}
    </TalkToUsContext.Provider>
  );
}

function TalkToUsModal({ onClose }: { onClose: () => void }) {
  const t = useT(COPY);
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<{ name?: string; email?: string; website?: string }>({});
  const [serverError, setServerError] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Lock body scroll while open; restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Escape; focus the first field on open.
  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status === 'submitting') return;

    const form = e.currentTarget;
    const data = new FormData(form);

    // Honeypot: if a bot filled the hidden field, silently pretend success.
    if (String(data.get('company') || '').trim() !== '') {
      setStatus('success');
      return;
    }

    const name = String(data.get('name') || '').trim().slice(0, LIMITS.name);
    const email = String(data.get('email') || '').trim().slice(0, LIMITS.email).toLowerCase();
    const website = String(data.get('website') || '').trim().slice(0, LIMITS.website);
    const communitySize = String(data.get('communitySize') || '').trim().slice(0, LIMITS.communitySize);
    const monthlyRevenue = String(data.get('monthlyRevenue') || '').trim().slice(0, LIMITS.monthlyRevenue);

    const nextErrors: typeof errors = {};
    if (!name) nextErrors.name = t.errName;
    if (!email || !EMAIL_REGEX.test(email)) nextErrors.email = t.errEmail;
    if (!website) nextErrors.website = t.errWebsite;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setStatus('submitting');
    setServerError(false);
    try {
      const res = await fetch(LEADS_ENDPOINT, {
        method: 'POST',
        // Use text/plain so this stays a CORS "simple" request and the browser
        // does NOT send a preflight. The site is served on both www.runhq.io and
        // the bare apex runhq.io; a preflight from the apex was being blocked and
        // silently dropping leads. The server parses the body as JSON by content,
        // so the header value doesn't affect handling.
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ name, email, website, communitySize, monthlyRevenue }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus('success');
    } catch {
      setStatus('error');
      setServerError(true);
    }
  };

  const modal = (
    <div
      className="rht-overlay"
      onMouseDown={(e) => {
        // Only close when the backdrop itself is pressed, not on drag from inside.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <style>{STYLES}</style>
      <div
        className="rht-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <button type="button" className="rht-close" aria-label={t.close} onClick={onClose}>
          ×
        </button>

        {status === 'success' ? (
          <div className="rht-success">
            <div className="rht-success-mark" aria-hidden="true">✓</div>
            <h2 id={titleId} className="rht-title">{t.successTitle}</h2>
            <p className="rht-subtitle">{t.successBody}</p>
            <button type="button" className="rhw-btn-primary rht-submit" onClick={onClose}>
              {t.done}
            </button>
          </div>
        ) : (
          <>
            <h2 id={titleId} className="rht-title">{t.title}</h2>
            <p className="rht-subtitle">{t.subtitle}</p>

            <form className="rht-form" onSubmit={handleSubmit} noValidate>
              {/* Honeypot — visually hidden, off-screen, ignored by real users. */}
              <div className="rht-hp" aria-hidden="true">
                <label>
                  Company
                  <input type="text" name="company" tabIndex={-1} autoComplete="off" />
                </label>
              </div>

              <Field
                label={t.name}
                name="name"
                maxLength={LIMITS.name}
                autoComplete="name"
                inputRef={firstFieldRef}
                error={errors.name}
                required
              />
              <Field
                label={t.email}
                name="email"
                type="email"
                maxLength={LIMITS.email}
                autoComplete="email"
                error={errors.email}
                required
              />
              <Field
                label={t.website}
                name="website"
                type="url"
                placeholder="example.com"
                maxLength={LIMITS.website}
                autoComplete="url"
                error={errors.website}
                required
              />
              <Field
                label={t.community}
                hint={t.communityHint}
                name="communitySize"
                maxLength={LIMITS.communitySize}
                inputMode="numeric"
              />
              <Field
                label={t.revenue}
                name="monthlyRevenue"
                maxLength={LIMITS.monthlyRevenue}
                optionalLabel={t.optional}
              />

              {status === 'error' && serverError && (
                <p className="rht-servererr" role="alert">
                  {t.errGeneric} {t.errFallbackPre}
                  <a href="mailto:admin@runhq.io">admin@runhq.io</a>.
                </p>
              )}

              <button
                type="submit"
                className="rhw-btn-primary rht-submit"
                disabled={status === 'submitting'}
              >
                {status === 'submitting' ? t.submitting : t.submit}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function Field({
  label,
  hint,
  name,
  type = 'text',
  maxLength,
  autoComplete,
  placeholder,
  inputMode,
  error,
  required,
  optionalLabel,
  inputRef,
}: {
  label: string;
  hint?: string;
  name: string;
  type?: string;
  maxLength?: number;
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text';
  error?: string;
  required?: boolean;
  optionalLabel?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className="rht-field">
      <label htmlFor={id} className="rht-label">
        {label}
        {optionalLabel && <span className="rht-optional"> ({optionalLabel})</span>}
      </label>
      {hint && <span className="rht-hint">{hint}</span>}
      <input
        id={id}
        name={name}
        type={type}
        ref={inputRef}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        inputMode={inputMode}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        className={`rht-input ${error ? 'rht-input-err' : ''}`}
      />
      {error && <span className="rht-error" role="alert">{error}</span>}
    </div>
  );
}

const STYLES = `
  .rht-overlay {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: flex-start; justify-content: center;
    padding: max(24px, 6vh) 16px 40px;
    background: rgba(20, 19, 15, 0.45);
    backdrop-filter: blur(2px);
    overflow-y: auto;
    animation: rht-fade 0.15s ease;
  }
  @keyframes rht-fade { from { opacity: 0; } to { opacity: 1; } }
  .rht-dialog {
    position: relative;
    width: 100%; max-width: 440px;
    background: var(--rhw-surface, #fff);
    color: var(--rhw-ink, #14130f);
    border: 1px solid var(--rhw-line, #e1dccf);
    border-radius: 16px;
    padding: 28px 26px 26px;
    box-shadow: 0 24px 60px -12px rgba(20, 19, 15, 0.35);
    animation: rht-rise 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes rht-rise { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .rht-close {
    position: absolute; top: 12px; right: 14px;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; line-height: 1;
    color: var(--rhw-ink-mute, #7a7568);
    background: transparent; border: none; border-radius: 8px; cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .rht-close:hover { background: var(--rhw-bg-2, #f4f1ea); color: var(--rhw-ink, #14130f); }
  .rht-title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
  .rht-subtitle { font-size: 14px; color: var(--rhw-ink-mute, #7a7568); margin: 0 0 20px; line-height: 1.45; }
  .rht-form { display: flex; flex-direction: column; gap: 14px; }
  .rht-field { display: flex; flex-direction: column; gap: 5px; }
  .rht-label { font-size: 13px; font-weight: 500; color: var(--rhw-ink-soft, #423f38); }
  .rht-optional { font-weight: 400; color: var(--rhw-ink-faint, #b3ad9d); }
  .rht-hint { font-size: 12px; color: var(--rhw-ink-mute, #7a7568); margin-top: -2px; }
  .rht-input {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px; font-family: inherit;
    color: var(--rhw-ink, #14130f);
    background: var(--rhw-bg, #fbfaf7);
    border: 1px solid var(--rhw-line, #e1dccf);
    border-radius: 9px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .rht-input::placeholder { color: var(--rhw-ink-faint, #b3ad9d); }
  .rht-input:focus {
    outline: none;
    border-color: var(--rhw-accent, #4a3ec8);
    box-shadow: 0 0 0 3px var(--rhw-accent-soft, rgba(74, 62, 200, 0.1));
  }
  .rht-input-err { border-color: var(--rhw-bad, #d44a3a); }
  .rht-error { font-size: 12px; color: var(--rhw-bad, #d44a3a); }
  .rht-servererr { font-size: 13px; color: var(--rhw-bad, #d44a3a); margin: 2px 0 0; }
  .rht-servererr a { color: var(--rhw-bad, #d44a3a); text-decoration: underline; }
  .rht-submit { margin-top: 6px; justify-content: center; width: 100%; border: none; cursor: pointer; font-family: inherit; }
  .rht-submit:disabled { opacity: 0.6; cursor: default; }
  .rht-success { text-align: center; padding: 8px 0 4px; }
  .rht-success-mark {
    width: 48px; height: 48px; margin: 4px auto 14px;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; color: #fff;
    background: var(--rhw-good, #1c8b50); border-radius: 50%;
  }
  .rht-hp {
    position: absolute !important;
    width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
`;
