/**
 * RunHQ's own product telemetry, through the RunHQ SDK this site already embeds.
 *
 * `widget.js` stopped being only a feedback widget. The same script, loaded with
 * the same project slug, now carries RunHQ's acquisition/CRM tracker:
 *
 *   - page views (including SPA navigation — it patches the History API itself,
 *     so react-router moves are seen without us reporting them),
 *   - first-touch attribution (landing URL + referrer, written once, never
 *     rewritten) and `?runhq_ref=` referral edges,
 *   - `identify` / `stage` / `track` / `revenue`, which are what turn an
 *     anonymous `rw_anon_id` into a *person* in RunHQ.
 *
 * The site was embedding only the feedback half: it mounted the widget and left
 * the tracker at its defaults, so every visitor stayed an anonymous id forever
 * and RunHQ could not see its own funnel. This module is the whole of the site's
 * use of the tracking half — one place to read to know what RunHQ records about
 * a visitor to its own marketing site.
 *
 * Two rules shape everything below.
 *
 * 1. CONSENT GOVERNS IT. Unlike GA (see analytics.ts), this tracker has no
 *    cookieless mode: its visitor id is a real `rw_anon_id` in localStorage,
 *    mirrored to a cookie on the registrable domain. That is precisely the
 *    "analytics cookie" the consent bar asks about, so it rides the same
 *    Accept/Decline switch, and every emitter here is a no-op until the visitor
 *    has accepted. Traffic is not lost by waiting: GA measures every visitor
 *    cookielessly from the first hit, so what consent buys RunHQ is the
 *    identified funnel on top, not the visit count.
 *
 * 2. THE ENVIRONMENT IS EXPLICIT. The SDK defaults `environment` to
 *    "production" when the embed says nothing, which is how staging traffic
 *    lands in the production numbers — the exact failure the GA work fixed by
 *    pointing staging at `VITE_GA_ID=none`. So the environment is declared per
 *    build, and the fallback when nobody declared one can never be "production"
 *    unless this really is the production build talking to the production API.
 */

import { storedConsent, type ConsentValue } from './analytics';
import { API_BASE, loadWidgetScript } from './widget';

/** The deployment an event belongs to, as RunHQ segments them. */
export type TelemetryEnv = 'production' | 'staging' | 'development';

const TELEMETRY_ENVS: readonly string[] = ['production', 'staging', 'development'];

/**
 * Which deployment this build reports as.
 *
 * `VITE_RUNHQ_ENV` is declared per environment in the deploy workflows, next to
 * `VITE_GA_ID`, and wins outright. It is plain config, not a secret.
 *
 * The fallback exists because a forgotten variable must fail towards *quiet*,
 * never towards polluting production:
 *   - a non-production build (local dev, tests) is always "development";
 *   - a production-mode build is read off the API host it was compiled against,
 *     which CI sets per environment (`console-staging.` ⇒ staging), so the
 *     staging site cannot report as production merely because someone forgot.
 *
 * Pure, so it is unit-testable without rebuilding under different envs.
 */
export function resolveTelemetryEnv(
  declared: string | undefined,
  apiBase: string,
  isProd: boolean,
): TelemetryEnv {
  const explicit = typeof declared === 'string' ? declared.trim().toLowerCase() : '';
  if (TELEMETRY_ENVS.includes(explicit)) return explicit as TelemetryEnv;
  if (!isProd) return 'development';
  return /staging/i.test(apiBase) ? 'staging' : 'production';
}

export const TELEMETRY_ENV = resolveTelemetryEnv(
  import.meta.env.VITE_RUNHQ_ENV,
  API_BASE,
  import.meta.env.PROD,
);

/**
 * Which of the two embed surfaces is initialising the widget.
 *
 * `marketing` is the floating launcher on RunHQ's own pages; `board` is the
 * full-page `/:slug` board, which belongs to whichever project the visitor
 * asked for — someone else's, usually.
 */
export type WidgetSurface = 'marketing' | 'board';

/**
 * Whether this widget instance may run the tracker.
 *
 * `board` is always false, and that is a correctness fix rather than caution.
 * The SDK starts tracking inside `init()` against the slug it was given and
 * pins that project for the lifetime of the page — the tracker has no notion of
 * the SPA later navigating away. So a visitor who landed on `www.runhq.io/arrr`
 * and then clicked through to `/pricing` was writing RunHQ's own marketing page
 * views into *arrr's* analytics. A customer's project must never receive
 * RunHQ's traffic, so the board surface mounts the widget with the tracker off.
 *
 * The cost is that a visit which only ever touches a board is not in RunHQ's
 * telemetry. GA still counts it (that is what the Consent Mode work bought),
 * and the moment the visitor reaches a marketing page the launcher starts the
 * tracker for RunHQ's own project.
 */
export function shouldTrack(consent: ConsentValue | null, surface: WidgetSurface): boolean {
  if (surface === 'board') return false;
  return consent === 'granted';
}

/**
 * The exact options object handed to `RunHQWidget.init()`.
 *
 * Both embed surfaces build their options here so the tracking decision and the
 * environment can never drift between them — the same reason `API_BASE` and
 * `RESERVED_SLUGS` live in one module.
 */
export function widgetInitOptions(args: {
  project: string;
  surface: WidgetSurface;
  consent: ConsentValue | null;
  standalone?: boolean;
  environment?: TelemetryEnv;
}): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    project: args.project,
    // Lets the visitor's same-site `rw_session` cookie flow, so RunHQ members
    // are recognised on both surfaces (see widget.ts).
    useCookieAuth: true,
    // `track: false` is the SDK's documented opt-out and is what keeps the
    // tracker dormant until consent; passing it explicitly (rather than relying
    // on a default) is what makes this readable at the call site.
    track: shouldTrack(args.consent, args.surface),
    environment: args.environment ?? TELEMETRY_ENV,
  };
  if (args.standalone) opts.standalone = true;
  return opts;
}

/** The SDK's tracking half — declared with the rest of its surface in widget.ts. */
type RunHQTracker = NonNullable<Window['RunHQWidget']>;

/** True once the visitor has accepted analytics. Every emitter checks this. */
export function telemetryConsented(): boolean {
  return storedConsent() === 'granted';
}

/**
 * Hand `emit` the SDK, or do nothing at all.
 *
 * Every call is gated on consent and wrapped: a marketing site must never break
 * because a measurement call threw, and the SDK's own methods already swallow
 * their failures, so the worst case here is silently recording less.
 *
 * `loadWidgetScript` is how we get the global rather than reading it directly —
 * it is idempotent and fires immediately when the script is already there, which
 * it is on every page that can emit. That closes the one real gap: a visitor who
 * submits the lead form before the async script settled would otherwise have
 * their identity dropped, which is the single event we least want to lose.
 */
function emit(fn: (sdk: RunHQTracker) => void): void {
  if (!telemetryConsented()) return;
  try {
    loadWidgetScript(() => {
      try {
        const sdk = window.RunHQWidget;
        if (sdk) fn(sdk);
      } catch {
        // Measurement must never surface an error to a visitor.
      }
    });
  } catch {
    // Same, for a failure to even reach the loader.
  }
}

/**
 * Join this browser's anonymous history to a real person.
 *
 * This is the call the site was missing entirely, and the reason RunHQ had no
 * users in its own CRM: without it the visitor id accumulates page views that
 * are never attached to anybody. The SDK backfills — the events already sent
 * under the anonymous id are joined to `userId` server-side — so identifying at
 * the first moment we genuinely learn who someone is recovers their whole
 * history, including the first-touch referrer that found them.
 *
 * The email is that moment: the visitor typed it into RunHQ's own form to be
 * contacted about RunHQ.
 */
export function identifyUser(userId: string, traits?: Record<string, unknown>): void {
  if (!userId) return;
  emit((sdk) => sdk.identify?.(userId, traits));
}

/**
 * Move the visitor to a named funnel stage (`lead`, `signup_started`, …).
 *
 * Stages are the coarse, ordered story of a person; `trackEvent` is the fine
 * detail underneath. Keep the vocabulary small — a stage nobody can define is
 * worse than no stage.
 */
export function trackStage(stageKey: string): void {
  if (!stageKey) return;
  emit((sdk) => sdk.stage?.(stageKey));
}

/** Record a named event, with optional metadata. */
export function trackEvent(name: string, meta?: Record<string, unknown>): void {
  if (!name) return;
  emit((sdk) => sdk.track?.(name, meta));
}

/**
 * The traits worth keeping from a "Talk to us" submission.
 *
 * Deliberately the same fields the form already sends to `POST /api/leads` and
 * nothing more: the point is to attach browsing history to the lead the sales
 * side will see, not to collect anything extra behind the visitor's back.
 */
export interface LeadTraits {
  name: string;
  email: string;
  website: string;
  communitySize?: string;
  monthlyRevenue?: string;
}

/**
 * A completed lead: identify the person, mark the stage, record the event.
 *
 * Email is the identity because it is the key the lead lands under in the admin
 * panel — the same string on both sides is what lets a lead be matched to the
 * sessions that produced it.
 */
export function identifyLead(lead: LeadTraits): void {
  const email = lead.email.trim().toLowerCase();
  if (!email) return;
  const traits: Record<string, unknown> = {
    email,
    name: lead.name,
    website: lead.website,
    source: 'talk_to_us',
  };
  if (lead.communitySize) traits.community_size = lead.communitySize;
  if (lead.monthlyRevenue) traits.monthly_revenue = lead.monthlyRevenue;

  identifyUser(email, traits);
  trackStage('lead');
  trackEvent('lead_submitted', { source: 'talk_to_us', website: lead.website });
}

/**
 * The visitor is leaving for `app.runhq.io` to sign up.
 *
 * This is the marketing site's real handoff, and it is worth recording here
 * even though the app will see the arrival: the tracker mirrors its visitor id
 * to a cookie on the registrable domain, so `www.` and `app.` are the same
 * person, and this event is what stitches "read the pricing page" to "opened
 * the signup form" in one story.
 */
export function trackSignupClick(source: string, meta?: Record<string, unknown>): void {
  trackStage('signup_started');
  trackEvent('signup_click', { source, ...meta });
}

/**
 * A returning user heading for the console. Not a funnel stage — signing in is
 * something an existing user does, not progress towards becoming one.
 */
export function trackSignInClick(source: string): void {
  trackEvent('sign_in_click', { source });
}

// ---------------------------------------------------------------------------
// Withdrawing consent
// ---------------------------------------------------------------------------

/** The SDK's own storage keys. See the tracking core in `widget.js`. */
const SDK_ANON_KEY = 'rw_anon_id';
const SDK_FIRST_TOUCH_KEY = 'rw_first_touch';
const SDK_REFERRER_KEY = 'rw_ref';

/**
 * Drop the identifiers the tracker keeps on this device.
 *
 * Called when a visitor declines, which includes visitors who were already
 * tracked: the widget ran the tracker for everyone before consent gated it, so
 * a returning visitor can be carrying an `rw_anon_id` they never agreed to.
 * Declining should take it away, not merely stop adding to it.
 *
 * This reaches into storage keys that belong to the SDK, because the SDK
 * exposes no "forget me". If it ever renames them this quietly stops cleaning
 * (it cannot break anything), so keep it in step with the tracking core.
 *
 * It does NOT stop a tracker that is already running: the SDK latches "started"
 * for the lifetime of the page and offers no way to unlatch it. Withdrawal
 * therefore stops the id from persisting now and stops tracking entirely from
 * the next page load.
 */
export function clearTelemetryIdentifiers(): void {
  try {
    localStorage.removeItem(SDK_ANON_KEY);
    localStorage.removeItem(SDK_FIRST_TOUCH_KEY);
  } catch {
    // Storage may be unavailable (private mode) — then there is nothing stored.
  }
  try {
    sessionStorage.removeItem(SDK_REFERRER_KEY);
  } catch {
    // As above.
  }
  try {
    // The id is mirrored to a cookie on the registrable domain so a
    // www → app hop is one visitor; expire it on both that domain and the
    // host itself, since either could be the one holding it.
    const host = window.location.hostname;
    const parts = host.split('.');
    const registrable = parts.length > 2 ? `.${parts.slice(-2).join('.')}` : host;
    for (const domain of new Set([registrable, host])) {
      document.cookie = `${SDK_ANON_KEY}=;path=/;max-age=0;domain=${domain};SameSite=Lax`;
    }
    document.cookie = `${SDK_ANON_KEY}=;path=/;max-age=0;SameSite=Lax`;
  } catch {
    // Cookies unavailable — nothing to expire.
  }
}
