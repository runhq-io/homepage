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
import { identifyLead, trackEvent, trackSignupClick } from '../telemetry';

// "Contact sales" modal, modelled on Stripe's: three steps in one dialog.
//
//   1. Your email  - just the work email.
//   2. Your info   - name and company. Continuing POSTs the lead to the RunHQ
//                    backend's public POST /api/leads (surfaces in the admin
//                    panel at console.runhq.io/admin/leads), so the lead is
//                    saved even if the visitor never books a time.
//   3. Let's talk  - our Calendly page, embedded and prefilled. Calendly owns
//                    availability and sends the invitation; we only listen for
//                    its "event scheduled" message to show the final screen.
//
// Client-side hardening mirrors the server (which is the real authority):
//  - Hidden honeypot field ("company") that humans never see.
//  - Required-field + email validation before we bother the network.
//  - Length caps identical to the server, so we never send it junk.
//  - Submit is disabled while in-flight (no double posts).

const LEADS_ENDPOINT = `${API_BASE}/api/leads`;
const BOOKING_URL = 'https://calendly.com/admin-runhq/30min';
const CALENDLY_ORIGIN = 'https://calendly.com';
// Same as chrome.tsx's SIGNUP_URL; not imported because chrome.tsx imports this module.
const SIGNUP_URL = 'https://app.runhq.io/signup';

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
    steps: ['Your email', 'Your info', "Let's talk"],
    emailTitle: 'Contact sales',
    emailSub: 'Enter your work email to get started.',
    email: 'Work email',
    infoTitle: 'How can we reach you?',
    infoSub: 'Tell us a little about your company.',
    firstName: 'First name',
    lastName: 'Last name',
    website: 'Company website',
    community: 'How many users do you have?',
    revenue: 'Monthly revenue',
    optional: 'Optional',
    continue: 'Continue',
    submitting: 'Sending…',
    talkTitle: 'Book a call',
    talkSub: 'Pick a time for a 30 minute call with our team.',
    talkLater: "Not ready to pick a time? Close this and we'll reach out by email.",
    close: 'Close',
    doneTitle: 'Your meeting is booked',
    doneBody: 'The invitation is on its way to your inbox.',
    doneSignupPre: 'Want to get started now?',
    doneSignup: 'Sign up',
    errFirstName: 'Please enter your first name.',
    errLastName: 'Please enter your last name.',
    errEmail: 'Please enter a valid email.',
    errWebsite: 'Please enter your company website.',
    errGeneric: 'Something went wrong.',
    errFallbackPre: 'Please try again, or email us at ',
  },
  ko: {
    steps: ['이메일', '정보', '상담'],
    emailTitle: '영업팀 문의',
    emailSub: '시작하려면 업무용 이메일을 입력하세요.',
    email: '업무용 이메일',
    infoTitle: '어떻게 연락드릴까요?',
    infoSub: '회사에 대해 간단히 알려주세요.',
    firstName: '이름',
    lastName: '성',
    website: '회사 웹사이트',
    community: '사용자가 몇 명인가요?',
    revenue: '월 매출',
    optional: '선택',
    continue: '계속',
    submitting: '보내는 중…',
    talkTitle: '통화 예약',
    talkSub: '팀과 30분 통화할 시간을 선택하세요.',
    talkLater: '지금 시간을 정하기 어렵다면 창을 닫으세요. 이메일로 연락드리겠습니다.',
    close: '닫기',
    doneTitle: '미팅이 예약되었습니다',
    doneBody: '초대장이 이메일로 발송되었습니다.',
    doneSignupPre: '바로 시작하시겠어요?',
    doneSignup: '가입하기',
    errFirstName: '이름을 입력해 주세요.',
    errLastName: '성을 입력해 주세요.',
    errEmail: '올바른 이메일을 입력해 주세요.',
    errWebsite: '회사 웹사이트를 입력해 주세요.',
    errGeneric: '문제가 발생했습니다.',
    errFallbackPre: '다시 시도하시거나 다음 이메일로 연락 주세요: ',
  },
} as const;

type Step = 0 | 1 | 2 | 'done';

interface TalkToUsContextValue {
  /** `cta` names the button that opened it, so the funnel can tell them apart. */
  open: (cta?: string) => void;
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
  cta,
}: {
  className?: string;
  children: ReactNode;
  /**
   * Which CTA this is, for telemetry — `nav`, `hero`, `pricing_footer`, and so
   * on. Optional so a new button cannot fail to compile, but name it: a funnel
   * that cannot say which button earned the lead is barely a funnel.
   */
  cta?: string;
}) {
  const { open } = useTalkToUs();
  return (
    <a
      className={className}
      href="#talk-to-us"
      role="button"
      onClick={(e) => {
        e.preventDefault();
        open(cta);
      }}
    >
      {children}
    </a>
  );
}

export function TalkToUsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback((cta?: string) => {
    setIsOpen(true);
    // Opening the form is the top of the lead funnel; `lead_submitted` (below)
    // is the bottom. Recording both is what makes the drop-off between them
    // visible, per CTA.
    trackEvent('talk_to_us_opened', { cta: cta ?? 'unknown', path: window.location.pathname });
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <TalkToUsContext.Provider value={{ open }}>
      {children}
      {isOpen && <TalkToUsModal onClose={close} />}
    </TalkToUsContext.Provider>
  );
}

/** Calendly's inline embed URL, prefilled so the visitor doesn't retype anything. */
function bookingSrc(firstName: string, lastName: string, email: string): string {
  const u = new URL(BOOKING_URL);
  u.searchParams.set('embed_domain', window.location.host);
  u.searchParams.set('embed_type', 'Inline');
  u.searchParams.set('hide_gdpr_banner', '1');
  // Our step already titles the call; drop Calendly's duplicate header.
  u.searchParams.set('hide_event_type_details', '1');
  u.searchParams.set('hide_landing_page_details', '1');
  u.searchParams.set('name', `${firstName} ${lastName}`.trim());
  u.searchParams.set('first_name', firstName);
  u.searchParams.set('last_name', lastName);
  u.searchParams.set('email', email);
  return u.toString();
}

function TalkToUsModal({ onClose }: { onClose: () => void }) {
  const t = useT(COPY);
  const [step, setStep] = useState<Step>(0);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'email' | 'firstName' | 'lastName' | 'website', string>>>({});
  const [frameH, setFrameH] = useState(680);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Lock body scroll while open; restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Each step focuses its first field (or its heading, when it has none).
  useEffect(() => {
    const root = bodyRef.current;
    const target = root?.querySelector<HTMLElement>('input:not([tabindex="-1"])') ?? root?.querySelector<HTMLElement>('h2');
    target?.focus();
  }, [step]);

  // Calendly reports its content height and, once booked, the scheduled event.
  useEffect(() => {
    if (step !== 2) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== CALENDLY_ORIGIN || !e.data || typeof e.data.event !== 'string') return;
      if (e.data.event === 'calendly.page_height') {
        const h = parseInt(String(e.data.payload?.height ?? ''), 10);
        if (h > 0) setFrameH(h);
      } else if (e.data.event === 'calendly.event_scheduled') {
        trackEvent('meeting_scheduled', { source: 'talk_to_us' });
        setStep('done');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [step]);

  const submitEmail = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('email') || '').trim().slice(0, LIMITS.email).toLowerCase();
    if (!EMAIL_REGEX.test(value)) {
      setErrors({ email: t.errEmail });
      return;
    }
    setErrors({});
    setEmail(value);
    trackEvent('talk_to_us_email', { source: 'talk_to_us' });
    setStep(1);
  };

  const submitInfo = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    const data = new FormData(e.currentTarget);

    // Honeypot: if a bot filled the hidden field, silently pretend success.
    if (String(data.get('company') || '').trim() !== '') {
      setStep('done');
      return;
    }

    const first = String(data.get('firstName') || '').trim();
    const last = String(data.get('lastName') || '').trim();
    const name = `${first} ${last}`.trim().slice(0, LIMITS.name);
    const website = String(data.get('website') || '').trim().slice(0, LIMITS.website);
    const communitySize = String(data.get('communitySize') || '').trim().slice(0, LIMITS.communitySize);
    const monthlyRevenue = String(data.get('monthlyRevenue') || '').trim().slice(0, LIMITS.monthlyRevenue);

    const nextErrors: typeof errors = {};
    if (!first) nextErrors.firstName = t.errFirstName;
    if (!last) nextErrors.lastName = t.errLastName;
    if (!website) nextErrors.website = t.errWebsite;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
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
      // The one moment this site learns who a visitor is. Identifying here
      // joins everything already recorded under their anonymous id — including
      // the first-touch referrer that found them — to the lead the sales side
      // will see in the admin panel. Only sends if they accepted analytics;
      // the lead itself reaches RunHQ either way, via the POST above.
      identifyLead({ name, email, website, communitySize, monthlyRevenue });
      setFirstName(first);
      setLastName(last);
      setStep(2);
    } catch {
      setServerError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const stepIndex = step === 'done' ? 3 : step;

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
        className={`rht-dialog ${step === 2 ? 'rht-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button type="button" className="rht-close" aria-label={t.close} onClick={onClose}>
          ×
        </button>

        <div ref={bodyRef}>
          {step !== 'done' && (
            <ol className="rht-steps">
              {t.steps.map((label, i) => {
                const state = i < stepIndex ? 'done' : i === stepIndex ? 'on' : 'todo';
                // Only the email can be revisited: once the lead is saved, going
                // back to edit it would post a duplicate.
                const canGoBack = i === 0 && step === 1;
                return (
                  <li key={label} className={`rht-step rht-step-${state}`} aria-current={i === stepIndex ? 'step' : undefined}>
                    {canGoBack ? (
                      <button type="button" onClick={() => setStep(0)}>
                        <span className="rht-step-dot" aria-hidden="true" />{label}
                      </button>
                    ) : (
                      <span><span className="rht-step-dot" aria-hidden="true" />{label}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {step === 0 && (
            <>
              <h2 id={titleId} className="rht-title" tabIndex={-1}>{t.emailTitle}</h2>
              <p className="rht-subtitle">{t.emailSub}</p>
              <form className="rht-form" onSubmit={submitEmail} noValidate>
                <Field
                  label={t.email}
                  name="email"
                  type="email"
                  defaultValue={email}
                  maxLength={LIMITS.email}
                  autoComplete="email"
                  error={errors.email}
                  required
                />
                <div className="rht-actions">
                  <button type="submit" className="rht-btn">{t.continue} ›</button>
                </div>
              </form>
            </>
          )}

          {step === 1 && (
            <>
              <h2 id={titleId} className="rht-title" tabIndex={-1}>{t.infoTitle}</h2>
              <p className="rht-subtitle">{t.infoSub}</p>
              <form className="rht-form" onSubmit={submitInfo} noValidate>
                {/* Honeypot — visually hidden, off-screen, ignored by real users. */}
                <div className="rht-hp" aria-hidden="true">
                  <label>
                    Company
                    <input type="text" name="company" tabIndex={-1} autoComplete="off" />
                  </label>
                </div>
                <Field label={t.firstName} name="firstName" defaultValue={firstName} maxLength={LIMITS.name} autoComplete="given-name" error={errors.firstName} required />
                <Field label={t.lastName} name="lastName" defaultValue={lastName} maxLength={LIMITS.name} autoComplete="family-name" error={errors.lastName} required />
                <Field label={t.website} name="website" type="url" placeholder="example.com" maxLength={LIMITS.website} autoComplete="url" error={errors.website} required />
                <Field label={t.community} name="communitySize" maxLength={LIMITS.communitySize} inputMode="numeric" />
                <Field label={t.revenue} name="monthlyRevenue" maxLength={LIMITS.monthlyRevenue} optionalLabel={t.optional} />

                {serverError && (
                  <p className="rht-servererr" role="alert">
                    {t.errGeneric} {t.errFallbackPre}
                    <a href="mailto:admin@runhq.io">admin@runhq.io</a>.
                  </p>
                )}

                <div className="rht-actions">
                  <button type="submit" className="rht-btn" disabled={submitting}>
                    {submitting ? t.submitting : `${t.continue} ›`}
                  </button>
                </div>
              </form>
            </>
          )}

          {step === 2 && (
            <>
              <h2 id={titleId} className="rht-title" tabIndex={-1}>{t.talkTitle}</h2>
              <p className="rht-subtitle">{t.talkSub}</p>
              <iframe
                className="rht-booking"
                title={t.talkTitle}
                src={bookingSrc(firstName, lastName, email)}
                style={{ height: frameH }}
              />
              <p className="rht-later">{t.talkLater}</p>
            </>
          )}

          {step === 'done' && (
            <div className="rht-done">
              <div className="rht-done-main">
                <h2 id={titleId} className="rht-title" tabIndex={-1}>{t.doneTitle}</h2>
                <p className="rht-subtitle">{t.doneBody}</p>
              </div>
              <div className="rht-done-foot">
                {t.doneSignupPre}{' '}
                <a href={SIGNUP_URL} onClick={() => trackSignupClick('talk_to_us_done')}>{t.doneSignup} ›</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function Field({
  label,
  name,
  type = 'text',
  defaultValue,
  maxLength,
  autoComplete,
  placeholder,
  inputMode,
  error,
  required,
  optionalLabel,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  maxLength?: number;
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text';
  error?: string;
  required?: boolean;
  optionalLabel?: string;
}) {
  const id = useId();
  return (
    <div className="rht-field">
      <label htmlFor={id} className="rht-label">
        {label}
        {optionalLabel && <span className="rht-optional">{optionalLabel}</span>}
      </label>
      <div className="rht-control">
        <input
          id={id}
          name={name}
          type={type}
          defaultValue={defaultValue}
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
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
  }
  @keyframes rht-fade { from { opacity: 0; } to { opacity: 1; } }
  .rht-dialog {
    position: relative; box-sizing: border-box;
    width: 100%; max-width: 600px;
    background: #fff;
    color: #14130f;
    border-radius: 10px;
    padding: 36px 40px 32px;
    box-shadow: 0 30px 80px -20px rgba(20, 19, 15, 0.45);
    animation: rht-rise 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .rht-dialog-wide { max-width: 760px; }
  /* Calendly pads its own top edge, so the subtitle needs no gap of its own. */
  .rht-dialog-wide .rht-subtitle { margin-bottom: 0; }
  @keyframes rht-rise { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .rht-overlay, .rht-dialog { animation: none; } }
  .rht-close {
    position: absolute; top: 14px; right: 14px;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; line-height: 1;
    color: #7a7568;
    background: transparent; border: none; border-radius: 6px; cursor: pointer;
  }
  .rht-close:hover { background: #f1f0ec; color: #14130f; }

  .rht-steps {
    list-style: none; margin: 0 40px 28px 0; padding: 0;
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
  }
  .rht-step > span, .rht-step > button {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 0 0 12px; border: 0; border-bottom: 2px solid #e6e4de;
    background: none; font: inherit; font-size: 14px; text-align: left;
    color: #a3a097;
  }
  .rht-step > button { cursor: pointer; }
  .rht-step > button:hover { color: #14130f; }
  .rht-step-on > span, .rht-step-done > span, .rht-step-done > button { border-bottom-color: #14130f; color: #14130f; }
  .rht-step-dot {
    width: 12px; height: 12px; flex: none; box-sizing: border-box;
    border-radius: 50%; border: 1.5px solid currentColor;
  }
  .rht-step-done .rht-step-dot { background: #14130f; border-color: #14130f; }

  .rht-title { font-size: 26px; font-weight: 500; letter-spacing: -0.015em; margin: 0 0 6px; outline: none; }
  .rht-subtitle { font-size: 15px; color: #6b675d; margin: 0 0 28px; line-height: 1.45; }
  .rht-form { display: flex; flex-direction: column; gap: 16px; }
  .rht-field { display: grid; grid-template-columns: 38% 1fr; gap: 16px; align-items: start; }
  .rht-label { font-size: 14px; font-weight: 500; color: #14130f; padding-top: 11px; }
  .rht-optional { display: block; font-weight: 400; color: #8d897d; }
  .rht-control { display: flex; flex-direction: column; gap: 5px; }
  .rht-input {
    box-sizing: border-box; width: 100%;
    padding: 10px 12px;
    font-size: 15px; font-family: inherit;
    color: #14130f;
    background: #fff;
    border: 1px solid #d9d6ce;
    border-radius: 6px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .rht-input::placeholder { color: #b3ad9d; }
  .rht-input:focus { outline: none; border-color: #14130f; box-shadow: 0 0 0 3px rgba(20, 19, 15, 0.08); }
  .rht-input-err { border-color: #d44a3a; }
  .rht-error { font-size: 12px; color: #d44a3a; }
  .rht-servererr { font-size: 13px; color: #d44a3a; margin: 2px 0 0; }
  .rht-servererr a { color: #d44a3a; text-decoration: underline; }
  .rht-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
  .rht-btn {
    padding: 11px 20px;
    font-family: inherit; font-size: 15px; font-weight: 500; line-height: 1;
    color: #fff; background: #14130f;
    border: none; border-radius: 6px; cursor: pointer;
  }
  .rht-btn:hover { background: #3a3832; }
  .rht-btn:disabled { opacity: 0.6; cursor: default; }

  .rht-booking { display: block; width: calc(100% + 16px); min-height: 560px; border: 0; margin: 0 -8px; }
  .rht-later { font-size: 13px; color: #8d897d; margin: 12px 0 0; text-align: center; }

  .rht-dialog:has(.rht-done) { padding: 0; overflow: hidden; }
  .rht-done-main { padding: 48px 40px 40px; text-align: center; }
  .rht-done-main .rht-subtitle { margin: 0; }
  .rht-done-foot { padding: 24px; text-align: center; font-size: 15px; color: #6b675d; background: #f7f6f3; }
  .rht-done-foot a { color: #14130f; font-weight: 500; text-decoration: none; }
  .rht-done-foot a:hover { text-decoration: underline; }

  .rht-hp {
    position: absolute !important;
    width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  @media (max-width: 560px) {
    .rht-dialog { padding: 28px 20px 24px; }
    .rht-steps { margin-right: 32px; gap: 8px; }
    .rht-step > span, .rht-step > button { font-size: 12px; gap: 6px; }
    .rht-field { grid-template-columns: 1fr; gap: 6px; }
    .rht-label { padding-top: 0; }
    .rht-optional { display: inline; margin-left: 6px; }
  }
`;
