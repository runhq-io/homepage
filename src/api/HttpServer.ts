/**
 * HTTP Server for API endpoints
 *
 * Provides REST API endpoints for:
 * - Claude API proxy (adds API key, tracks usage)
 * - Checkpoint storage
 * - Usage tracking
 */

import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import oauth from './oauth/index';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createToken, verifyToken, extractUserIdFromToken } from './auth/jwt';
import { getSettings } from './services/SettingsService';
import * as UsageService from './services/UsageService';
import * as UsageReportService from './services/UsageReportService';
import * as StripeService from './services/StripeService';
import * as InviteService from './services/InviteService';
import { assertActivated } from '../lib/signupGating';
import * as TelemetryService from './services/TelemetryService';
import * as ServerService from './services/ServerService';
import { registerGithubRoutes } from './github/githubRoutes';
import { registerInternalGithubRoutes } from './github/internalGithubRoutes';
import { getGithubAppConfig, isGithubAppConfigured } from './github/config';
import * as GithubInstallationsService from './services/GithubInstallationsService';
import * as GithubProjectReposService from './services/GithubProjectReposService';
import { aggregateForUser } from './services/GithubAggregationService';
import { getGitHubAppService } from './services/GitHubAppService';
import * as ServerAdminMirrorService from './services/ServerAdminMirrorService';
import * as AutoHealService from './services/AutoHealService';
import * as ServerSessionService from './services/ServerSessionService';
import { getServerSessionKeyPair } from './auth/serverSessionKeys';
import * as PublicPortService from './services/PublicPortService';
import * as MachineUsageService from './services/MachineUsageService';
import * as WidgetService from './services/WidgetService';
import * as ClarifierService from './services/ClarifierService';
import * as DedupService from './services/DedupService';
import { widgetRateLimiter, type WidgetAction } from './services/WidgetRateLimiter';
import * as WidgetChatService from './services/WidgetChatService';
import { streamSSE } from 'hono/streaming';
import * as WorkspaceTaskService from './services/WorkspaceTaskService';
import {
  listFeed as listActivityFeed,
  countNew as countNewActivity,
  memberStats as activityMemberStats,
  memberActivity as activityMemberActivity,
} from './services/WorkspaceTaskActivityFeedService';
import { TaskAttachmentStorageService } from './services/TaskAttachmentStorageService';
import * as PreviewCoordinator from './services/PreviewCoordinator';
import { getProvider, hasProvider, getDefaultProviderId, isAnyProviderConfigured } from './services/providers/registry';
import { inferRegionFromCountry, DEFAULT_REGION } from './services/regionInference';
import type { ProviderId } from './services/providers/types';
import type { Screenshot, TokenUsage } from '@runhq/server-protocol';
import { TODO_STATUS_DISPLAY } from '@runhq/server-protocol';
import type { PlanId } from '../db/schema';
import { db } from '../db/index';
import { users, deviceCodes, servers, serverTemplates, agentTemplates, systemSettings, serverMembers, subscriptions, harnessCases, notifications, notificationDeliveries, userNotificationPreferences, notificationMutes, pushSubscriptions } from '../db/schema';
import { eq, lt, sql, and, isNotNull, like, asc, desc, isNull } from 'drizzle-orm';
import { serializeNotification } from '../notifications/serialize';
import { getOrCreatePreferences } from '../notifications/gates';
import { insertNotificationWithDeliveries, deriveServerTokenActor } from '../notifications/emitTaskNotification';
import { dispatchNotification } from '../notifications/dispatch';
import { broadcastToUser } from '../notifications/wsBroadcast';
import { wsServer as getWsServer } from '../notifications/wsRegistry';
import { getUserByUsername } from '../db/services';
export { DEV_LOCAL_USER_ID } from '../db/seed-dev-local-user';
import { DEV_LOCAL_USER_ID } from '../db/seed-dev-local-user';
import { calculateCost, type TokenCounts } from './services/pricing';
import { trackUsage, type TrackUsageContext } from './services/UsageService';
import { sendInviteEmail } from '../lib/email';
import { nanoid } from 'nanoid';
import { createHmac, createHash } from 'node:crypto';

type BuildInfo = {
  gitSha?: string;
  ref?: string;
  runNumber?: number;
  builtAt?: string;
};

let cachedBuildInfo: BuildInfo | null | undefined;

// Latest server version — persisted in system_settings, cached in memory
let _cachedLatestServerVersion: string | null = null;
let _versionCacheTime = 0;
const VERSION_CACHE_TTL = 60_000; // 1 minute

async function getLatestServerVersion(): Promise<string | null> {
  if (_cachedLatestServerVersion && Date.now() - _versionCacheTime < VERSION_CACHE_TTL) {
    return _cachedLatestServerVersion;
  }
  try {
    const [row] = await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, 'latest_server_version'));
    _cachedLatestServerVersion = row?.value ?? null;
    _versionCacheTime = Date.now();
  } catch (err) {
    console.error('[HttpServer] Failed to read latest_server_version:', err);
  }
  return _cachedLatestServerVersion;
}

async function setLatestServerVersion(version: string): Promise<void> {
  await db.insert(systemSettings).values({ key: 'latest_server_version', value: version }).onConflictDoUpdate({
    target: systemSettings.key,
    set: { value: version, updatedAt: new Date() },
  });
  _cachedLatestServerVersion = version;
  _versionCacheTime = Date.now();
}

function getBuildInfo(): BuildInfo | null {
  if (cachedBuildInfo !== undefined) return cachedBuildInfo;

  // Baked into the deploy artifact by GitHub Actions (see workflow).
  const filePath = path.join(process.cwd(), 'dist', 'build-info.json');
  try {
    cachedBuildInfo = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BuildInfo;
  } catch {
    cachedBuildInfo = null;
  }
  return cachedBuildInfo;
}

// ============================================================================
// Widget constants injection
// ============================================================================
//
// The embeddable widget (public/widget.js) renders status chips for tickets.
// To prevent the widget's vocabulary from drifting away from the protocol's
// TodoStatus union (the regression that caused 'deployed' to render as
// 'Open'), we inject the canonical TODO_STATUS_DISPLAY registry into the
// served widget body. The widget then reads from window.__RW_CONSTANTS__
// instead of carrying its own hand-maintained STATUS table.
//
// The header is computed once at module load — the registry is static at
// runtime, only changes on deploy.

let cachedWidgetConstantsHeader: string | null = null;

function renderWidgetConstantsHeader(): string {
  if (cachedWidgetConstantsHeader !== null) return cachedWidgetConstantsHeader;
  const payload = JSON.stringify({ status: TODO_STATUS_DISPLAY });
  cachedWidgetConstantsHeader =
    `/* RunHQ widget constants — injected from @runhq/server-protocol TODO_STATUS_DISPLAY */\n` +
    `;(function(){if(typeof window==='undefined')return;` +
    `var c=window.__RW_CONSTANTS__=window.__RW_CONSTANTS__||{};` +
    `var p=${payload};for(var k in p){c[k]=p[k];}})();\n`;
  return cachedWidgetConstantsHeader;
}

// ============================================================================
// Types
// ============================================================================

interface ClaudeAnalyzeRequest {
  screenshot?: {
    imageBase64: string;
    url: string;
    title: string;
    timestamp: number;
  } | null;
  prompt: string;
  conversationId?: string;
  config?: {
    checkCompletion?: boolean;
    canAsk?: boolean;
    promptTemplate?: string;
    model?: string;
    maxTokens?: number;
  };
}

interface ClaudeAnalyzeResponse {
  thought: string;
  response?: string; // User-facing message (for conversational replies)
  action: { type: string;[key: string]: unknown } | null;
  complete: boolean;
  needsHelp?: boolean;
  question?: string;
  tokenUsage?: TokenUsage;
}

// ============================================================================
// Create Hono App
// ============================================================================

export function createHttpApp() {
  const app = new Hono();

  /**
   * Unified CORS middleware (replaces the prior `hono/cors` global).
   *
   * Two response shapes, chosen per request:
   *
   * 1. **Widget cookie-auth path** — when the request is on `/api/widget/*`
   *    and its `Origin` matches an entry in some enabled project's
   *    `allowed_origins`: echo `Access-Control-Allow-Origin: <origin>`
   *    plus `Allow-Credentials: true` and `Vary: Origin`. This is the
   *    ONLY shape browsers will accept alongside `credentials: include`,
   *    so it's how the rw_session cookie + X-RunHQ-CSRF traffic flows.
   *
   * 2. **Legacy `*` path** — everything else: `Access-Control-Allow-Origin: *`,
   *    no credentials. Token-bearer widgets, the public widget.js script
   *    asset, and the rest of the cloud API all keep working unchanged.
   *
   * Why not use hono/cors with an `origin` function: the allowlist check is
   * async (DB lookup) and hono/cors's origin callback is sync. We could
   * cache the allowlist in memory, but the lookup is a single indexed
   * `text[] @> ARRAY[$1]::text[]` query — cheap enough to do per request,
   * and skipping the cache avoids stale-allowlist windows when an owner
   * adds/removes an origin.
   *
   * Headers list intentionally includes `X-RunHQ-CSRF`. Without it, the
   * browser strips the header at the preflight stage and our CSRF gate
   * sees no token → write requests on the cookie path 403 even when the
   * client is doing everything right.
   */
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    const isWidgetPath = c.req.path.startsWith('/api/widget/');

    let allowOriginValue = '*';
    let withCredentials = false;
    if (isWidgetPath && origin) {
      // isOriginAllowlisted returns true iff any enabled project lists this
      // origin. Per-project enforcement of "which user can authenticate
      // here" happens later in authenticateWidget Mode 0; this only widens
      // the CORS envelope so the browser will send cookies in the first place.
      if (await WidgetService.isOriginAllowlisted(origin)) {
        allowOriginValue = origin;
        withCredentials = true;
      }
    }

    c.header('Access-Control-Allow-Origin', allowOriginValue);
    if (withCredentials) {
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Cache-Control, X-RW-Project, X-RunHQ-CSRF, X-Server-Token',
    );

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }

    await next();
  });

  // Serve widget.js with the canonical status registry injected at the
  // top of the body. The widget reads from window.__RW_CONSTANTS__.status
  // rather than carrying its own STATUS table — this guarantees the
  // displayed labels stay in lockstep with the protocol's TodoStatus union.
  app.get('/widget.js', (c) => {
    const filePath = path.join(process.cwd(), 'public', 'widget.js');
    const widgetSource = fs.readFileSync(filePath, 'utf-8');
    const body = renderWidgetConstantsHeader() + widgetSource;
    // The charset matters: widget.js contains UTF-8 strings (Korean
    // locale tables, em dashes, smart quotes). Without it the browser
    // falls back to Latin-1 and renders the bytes as � replacement
    // characters. Next.js's static handler set this automatically; the
    // Hono route has to be explicit.
    // Strong ETag over the exact bytes we'd send (constants header + widget
    // source). Combined with `no-cache`, this gives correct propagation:
    // browsers and the CDN MAY store the response but MUST revalidate with
    // the origin before each use. When the content is unchanged the
    // revalidation is a tiny conditional 304 (no body), so steady-state
    // bandwidth is unchanged; the moment we ship a widget fix every embed
    // picks it up on its next load instead of being pinned to a stale copy
    // for up to an hour. `no-cache` does NOT mean "don't store" — it means
    // "store but always revalidate", which is exactly right for an
    // embeddable, URL-loaded bootstrap script that must stay current.
    const etag = '"' + createHash('sha256').update(body).digest('base64url') + '"';
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    c.header('ETag', etag);
    c.header('Access-Control-Allow-Origin', '*');
    const inm = c.req.header('if-none-match');
    if (inm && inm === etag) {
      return c.body(null, 304);
    }
    return c.body(body);
  });

  // JWKS — public key(s) used to verify server session JWTs (EdDSA).
  // Workspaces fetch this to verify tokens without holding the private key.
  app.get('/.well-known/jwks.json', async (c) => {
    const { publicJwk } = await getServerSessionKeyPair();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ keys: [publicJwk] });
  });

  // Health check endpoint
  app.get('/health', (c) => {
    const start = Date.now();
    const buildInfo = getBuildInfo();
    const responseTimeMs = Date.now() - start;

    c.header('Cache-Control', 'no-store');
    c.header('x-response-time-ms', String(responseTimeMs));

    return c.json({
      status: 'ok',
      service: 'api',
      test: true,
      timestamp: Date.now(),
      responseTimeMs,
      uptimeSeconds: Math.floor(process.uptime()),
      build: buildInfo ?? {},
    });
  });

  // ==========================================================================
  // Auth - Token validation for web client
  // ==========================================================================
  // ==========================================================================
  // Device Auth (for desktop OAuth flow)
  // ==========================================================================

  // POST /api/auth/device - Generate a new device code (called by desktop app)
  app.post('/api/auth/device', async (c) => {
    try {
      const deviceCode = nanoid(32);
      const userCode = nanoid(8).toUpperCase();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store in database
      await db.insert(deviceCodes).values({
        deviceCode,
        userCode,
        expiresAt,
        interval: 5,
      });

      // Console URL for user verification (OAuth happens there)
      const consoleUrl = process.env.NEXTAUTH_URL || 'http://localhost:9000';

      return c.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${consoleUrl}/auth/device`,
        verification_uri_complete: `${consoleUrl}/auth/device?code=${userCode}`,
        expires_in: 600,
        interval: 5,
      });
    } catch (error) {
      console.error('[HttpServer] Device code generation error:', error);
      return c.json({ error: 'Failed to generate device code' }, 500);
    }
  });

  // GET /api/auth/device?device_code=xxx - Poll for authorization status
  app.get('/api/auth/device', async (c) => {
    try {
      const deviceCode = c.req.query('device_code');

      if (!deviceCode) {
        return c.json({ error: 'missing_device_code' }, 400);
      }

      // Get code from database
      const [codeData] = await db.select().from(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));

      if (!codeData) {
        return c.json({ error: 'expired_token' }, 400);
      }

      // Check if expired
      if (codeData.expiresAt < new Date()) {
        await db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));
        return c.json({ error: 'expired_token' }, 400);
      }

      // Check if user has authorized
      if (!codeData.userId) {
        return c.json({ error: 'authorization_pending' }, 400);
      }

      // Get user data
      const [user] = await db.select().from(users).where(eq(users.id, codeData.userId));

      if (!user) {
        return c.json({ error: 'invalid_user' }, 400);
      }

      // Clean up the code
      await db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));

      // Generate signed JWT token
      const token = await createToken(user.id);

      return c.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        token,
      });
    } catch (error) {
      console.error('[HttpServer] Device code poll error:', error);
      return c.json({ error: 'internal_error' }, 500);
    }
  });

  // POST /api/auth/device/token - Poll via POST (alternative to GET)
  app.post('/api/auth/device/token', async (c) => {
    try {
      const body = await c.req.json();
      const deviceCode = body?.device_code;

      if (!deviceCode) {
        return c.json({ error: 'missing_device_code' }, 400);
      }

      // Get code from database
      const [codeData] = await db.select().from(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));

      if (!codeData) {
        return c.json({ error: 'expired_token' }, 400);
      }

      // Check if expired
      if (codeData.expiresAt < new Date()) {
        await db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));
        return c.json({ error: 'expired_token' }, 400);
      }

      // Check if user has authorized
      if (!codeData.userId) {
        return c.json({ error: 'authorization_pending' }, 400);
      }

      // Get user data
      const [user] = await db.select().from(users).where(eq(users.id, codeData.userId));

      if (!user) {
        return c.json({ error: 'invalid_user' }, 400);
      }

      // Clean up the code
      await db.delete(deviceCodes).where(eq(deviceCodes.deviceCode, deviceCode));

      // Generate signed JWT token
      const token = await createToken(user.id);

      return c.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        token,
      });
    } catch (error) {
      console.error('[HttpServer] Device token exchange error:', error);
      return c.json({ error: 'internal_error' }, 500);
    }
  });

  // ==========================================================================
  // Telemetry (authenticated)
  // ==========================================================================
  // Desktop app sends product telemetry here; server forwards to GA4 Measurement Protocol.
  // This keeps GA API secrets off the Electron client and avoids loosening renderer CSP.
  app.post('/api/telemetry/track', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const body = await c.req.json() as {
        clientId?: string;
        event?: { name: string; params?: Record<string, unknown> };
        events?: Array<{ name: string; params?: Record<string, unknown> }>;
        context?: { appVersion?: string; platform?: string; locale?: string; userAgent?: string };
      };

      const clientId = body.clientId;
      const events = Array.isArray(body.events)
        ? body.events
        : (body.event ? [body.event] : []);

      if (!clientId || typeof clientId !== 'string') {
        return c.json({ error: 'Missing clientId' }, 400);
      }
      if (events.length === 0) {
        return c.json({ error: 'Missing events' }, 400);
      }

      const result = await TelemetryService.trackGa4({
        clientId,
        userId,
        events,
        context: {
          ...body.context,
          // Server-side safety: always tag platform as electron unless explicitly provided.
          platform: body.context?.platform || 'electron',
          userAgent: body.context?.userAgent || c.req.header('user-agent') || undefined,
        },
      });

      // Telemetry must never break clients; return 200 even if forwarding fails.
      return c.json({ ok: true, ...result });
    } catch (error) {
      console.error('[HttpServer] Telemetry error:', error);
      // Fail-safe
      return c.json({ ok: true, enabled: false, forwarded: false }, 200);
    }
  });

  // Stripe Checkout redirect targets (user-facing)
  // Some clients configure Stripe success/cancel URLs to point at the API domain.
  // Provide non-404 routes that redirect users back to the portal or show a friendly message.
  app.get('/billing/success', (c) => {
    const sessionId = c.req.query('session_id');
    const portalBaseUrl = process.env.NEXTAUTH_URL;

    if (portalBaseUrl) {
      try {
        const url = new URL('/', portalBaseUrl);
        url.searchParams.set('billing', 'success');
        if (sessionId) url.searchParams.set('session_id', sessionId);
        return c.redirect(url.toString(), 302);
      } catch {
        // Fall back to a plain text message below
      }
    }

    return c.text(
      'Payment complete. You can close this window and return to the app. (If your credits/plan do not update within a minute, please contact support.)',
      200,
    );
  });

  app.get('/billing/cancel', (c) => {
    const portalBaseUrl = process.env.NEXTAUTH_URL;
    if (portalBaseUrl) {
      try {
        const url = new URL('/', portalBaseUrl);
        url.searchParams.set('billing', 'cancel');
        return c.redirect(url.toString(), 302);
      } catch {
        // Fall back to a plain text message below
      }
    }

    return c.text('Payment cancelled. You can close this window and return to the app.', 200);
  });

  // Claude API proxy endpoint
  app.post('/api/claude/analyze', async (c) => {
    try {
      // Get auth token
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Missing or invalid Authorization header' }, 401);
      }

      const token = authHeader.substring(7);

      // Validate token (for now, just check it exists)
      if (!token || token.length < 10) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Check credit balance before proceeding
      const creditCheck = await UsageService.checkCreditBalanceForServer(token, readContextHeaders(c).serverId);
      if (!creditCheck.allowed) {
        const code =
          creditCheck.reason === 'past_due' ? 'PAYMENT_PAST_DUE' :
          creditCheck.reason === 'no_subscription' ? 'NO_SUBSCRIPTION' :
          'INSUFFICIENT_CREDITS';
        const errorResponse: Record<string, unknown> = {
          error: creditCheck.reason === 'insufficient_credits'
            ? 'Insufficient credits - please add more credits to continue'
            : creditCheck.reason === 'past_due'
              ? 'Payment past due - please update your payment method'
              : 'Subscription required',
          code,
          reason: creditCheck.reason,
          balanceCents: creditCheck.balanceCents,
          plan: creditCheck.plan,
          hasPaymentMethod: creditCheck.hasPaymentMethod,
          periodEnd: creditCheck.periodEnd.toISOString(),
        };
        return c.json(errorResponse, 402);
      }

      // Parse request body
      const body = await c.req.json() as ClaudeAnalyzeRequest;

      // Screenshot is now optional - allows text-only conversational messages

      // Get settings (includes API key)
      const settings = await getSettings();
      if (!settings.claudeApiKey) {
        console.error('[HttpServer] No Claude API key configured');
        return c.json({ error: 'Server configuration error' }, 500);
      }

      // Create Anthropic client with server's API key
      const client = new Anthropic({ apiKey: settings.claudeApiKey });

      // Build system prompt
      const model = resolveModel(body.config?.model || settings.claudeModel || 'claude-sonnet-4-6');
      const maxTokens = body.config?.maxTokens || 1024;

      // The full orchestration prompt from the client contains:
      // - Persona, objective, context, decision flow instructions
      // This goes in the USER message so Claude sees it with the screenshot
      const userPromptText = body.prompt || 'Analyze the current state and decide the next action.';

      // System prompt is minimal - output format is enforced by response_format
      const systemPrompt = 'You are an AI agent that helps users accomplish tasks.';

      console.log(`[HttpServer] Claude API request - model: ${model}, hasPrompt: ${!!body.prompt}, promptLength: ${body.prompt?.length || 0}`);

      // Build message content - include screenshot if provided
      const hasScreenshot = body.screenshot?.imageBase64;

      // Call Claude API with native JSON mode
      const startTime = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        stream: false,  // Ensure we get a Message, not a Stream
        messages: [
          {
            role: 'user',
            content: hasScreenshot
              ? [
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'image/png' as const,
                    data: body.screenshot!.imageBase64,
                  },
                },
                {
                  type: 'text' as const,
                  text: userPromptText,
                },
              ]
              : [
                {
                  type: 'text' as const,
                  text: userPromptText,
                },
              ],
          },
        ],
        system: systemPrompt,
      });

      const elapsed = Date.now() - startTime;
      console.log(`[HttpServer] Claude API responded in ${elapsed}ms`);

      // Calculate token usage
      const rawUsage: any = response.usage || {};
      const tokens: TokenCounts = {
        inputTokens:         rawUsage.input_tokens                  || 0,
        outputTokens:        rawUsage.output_tokens                 || 0,
        cacheReadTokens:     rawUsage.cache_read_input_tokens       || 0,
        cacheCreationTokens: rawUsage.cache_creation_input_tokens   || 0,
      };
      const totalTokens = tokens.inputTokens + tokens.outputTokens;
      const costCents = calculateCost(model, tokens);

      const tokenUsage: TokenUsage = {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        totalTokens,
        model,
        costCents,
      };

      // Track usage (async, don't wait)
      const _analyzeUserId = UsageService.extractUserIdFromToken(token);
      if (_analyzeUserId) {
        const _analyzeContext = readContextHeaders(c);
        const _analyzeReqId = (response as any)?.id ?? null;
        trackUsage({
          userId: _analyzeUserId,
          model,
          tokens,
          costCents,
          context: _analyzeContext,
          anthropicRequestId: _analyzeReqId,
        }).catch(err => {
          console.error('[HttpServer] trackUsage failed', err);
        });
      }

      // Parse response
      const textContent = response.content.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return c.json({
          thought: 'No response from Claude',
          action: null,
          complete: true,
          tokenUsage,
        } as ClaudeAnalyzeResponse);
      }

      // Parse JSON from response
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[HttpServer] Could not parse JSON from Claude response:', textContent.text.substring(0, 200));
        return c.json({
          thought: textContent.text.split('\n')[0],
          action: null,
          complete: false,
          tokenUsage,
        } as ClaudeAnalyzeResponse);
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // DEBUG: Log what Claude returned
      console.log('[HttpServer] Claude parsed response:', JSON.stringify({
        thought: parsed.thought?.substring(0, 100),
        action: parsed.action,
        intent: parsed.intent,
        complete: parsed.complete,
        hasResponse: !!parsed.response,
      }));

      const result: ClaudeAnalyzeResponse = {
        thought: parsed.thought || '',
        response: parsed.response,
        action: parsed.action || null,
        complete: parsed.complete || false,
        needsHelp: parsed.needsHelp,
        question: parsed.question,
        tokenUsage,
      };

      return c.json(result);

    } catch (error) {
      console.error('[HttpServer] Claude API error:', error);

      if (error instanceof Error) {
        if (error.message.includes('rate_limit')) {
          return c.json({ error: 'Rate limit exceeded - please wait before trying again' }, 429);
        }
        if (error.message.includes('invalid_api_key')) {
          return c.json({ error: 'Server configuration error' }, 500);
        }
      }

      return c.json({
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Checkpoint endpoints
  app.post('/api/checkpoints', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const body = await c.req.json();
      // TODO: Implement checkpoint storage
      console.log('[HttpServer] Checkpoint save request:', body.reason);

      return c.json({
        success: true,
        checkpointId: `checkpoint_${Date.now()}`
      });
    } catch (error) {
      console.error('[HttpServer] Checkpoint save error:', error);
      return c.json({ error: 'Failed to save checkpoint' }, 500);
    }
  });

  app.get('/api/checkpoints/:agentId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const agentId = c.req.param('agentId');
      // TODO: Implement checkpoint retrieval
      console.log('[HttpServer] Checkpoint list request for agent:', agentId);

      return c.json({ checkpoints: [] });
    } catch (error) {
      console.error('[HttpServer] Checkpoint list error:', error);
      return c.json({ error: 'Failed to list checkpoints' }, 500);
    }
  });

  app.get('/api/checkpoints/:agentId/:checkpointId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const { agentId, checkpointId } = c.req.param();
      // TODO: Implement checkpoint retrieval
      console.log('[HttpServer] Checkpoint load request:', agentId, checkpointId);

      return c.json({ checkpoint: null });
    } catch (error) {
      console.error('[HttpServer] Checkpoint load error:', error);
      return c.json({ error: 'Failed to load checkpoint' }, 500);
    }
  });

  // Strict ID validation: opaque IDs are alphanumeric + [_-], max 128 chars.
  // Fly machine IDs, UUIDs, and our own generated IDs all fit.
  const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

  function readContextHeaders(c: any): TrackUsageContext {
    const idOrNull = (s: string | undefined): string | null =>
      (s && CONTEXT_ID_PATTERN.test(s)) ? s : null;

    const labelOrNull = (s: string | undefined, max = 256): string | null => {
      if (!s) return null;
      try {
        return decodeURIComponent(s).slice(0, max);
      } catch {
        return null;
      }
    };

    return {
      serverId:       idOrNull(c.req.header('X-Server-Id')),
      taskId:         idOrNull(c.req.header('X-Task-Id')),
      taskLabel:      labelOrNull(c.req.header('X-Task-Label')),
      jobId:          idOrNull(c.req.header('X-Job-Id')),
      channelId:      idOrNull(c.req.header('X-Channel-Id')),
      channelLabel:   labelOrNull(c.req.header('X-Channel-Label')),
      agentId:        idOrNull(c.req.header('X-Agent-Id')),
      agentLabel:     labelOrNull(c.req.header('X-Agent-Label')),
      conversationId: idOrNull(c.req.header('X-Conversation-Id')),
    };
  }

  // Claude Tools API endpoint (v3 tool-based agent)
  app.post('/api/claude/tools', async (c) => {
    try {
      // Get auth token
      const authHeader = c.req.header('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

      // Dev mode bypass: skip auth in development
      const isDev = process.env.NODE_ENV !== 'production';
      if (!isDev) {
        if (!token || token.length < 10) {
          return c.json({ error: 'Missing or invalid Authorization header' }, 401);
        }

        // Check credit balance before proceeding
        const creditCheck = await UsageService.checkCreditBalanceForServer(token, readContextHeaders(c).serverId);
        if (!creditCheck.allowed) {
          const code =
            creditCheck.reason === 'past_due' ? 'PAYMENT_PAST_DUE' :
            creditCheck.reason === 'no_subscription' ? 'NO_SUBSCRIPTION' :
            'INSUFFICIENT_CREDITS';
          const errorResponse: Record<string, unknown> = {
            error: creditCheck.reason === 'insufficient_credits'
              ? 'Insufficient credits - please add more credits to continue'
              : creditCheck.reason === 'past_due'
                ? 'Payment past due - please update your payment method'
                : 'Subscription required',
            code,
            reason: creditCheck.reason,
            balanceCents: creditCheck.balanceCents,
            plan: creditCheck.plan,
            hasPaymentMethod: creditCheck.hasPaymentMethod,
            periodEnd: creditCheck.periodEnd.toISOString(),
          };
          return c.json(errorResponse, 402);
        }
      } else if (!token) {
        console.log('[HttpServer] Dev mode: allowing unauthenticated Claude tools request');
      }

      // Parse request body
      const body = await c.req.json() as {
        system: string;
        messages: Array<{ role: string; content: unknown }>;
        tools: Array<{
          name: string;
          description: string;
          input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
        }>;
        max_tokens?: number;
        model?: string;
        tool_choice?: Anthropic.Messages.ToolChoice;
      };

      // Get settings
      const settings = await getSettings();
      if (!settings.claudeApiKey) {
        console.error('[HttpServer] No Claude API key configured');
        return c.json({ error: 'Server configuration error' }, 500);
      }

      // Create Anthropic client
      const client = new Anthropic({ apiKey: settings.claudeApiKey });

      const model = resolveModel(body.model || settings.claudeModel || 'claude-sonnet-4-6');
      const maxTokens = body.max_tokens || 4096;

      // Filter out messages with empty content (Claude API rejects these)
      const validMessages = (body.messages as Anthropic.MessageParam[]).filter((msg) => {
        if (msg.content === null || msg.content === undefined) {
          return false;
        }
        if (typeof msg.content === 'string') {
          return msg.content.trim().length > 0;
        }
        if (Array.isArray(msg.content)) {
          return msg.content.length > 0;
        }
        return false;
      });

      console.log(`[HttpServer] Claude Tools API - model: ${model}, messages: ${validMessages.length} (filtered from ${body.messages.length}), tools: ${body.tools.length}, tool_choice: ${JSON.stringify(body.tool_choice || 'auto')}`);

      // Call Claude API with tools
      // Include web_search server tool for research tasks (text-based, no screenshots needed)
      const startTime = Date.now();

      // === PROMPT CACHING ===
      // Add cache_control breakpoints to reduce costs by ~90% on repeated content
      // See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

      // 1. System prompt with cache_control (this is large and sent every request)
      const systemWithCache = Array.isArray(body.system)
        ? body.system.map((block: any, i: number, arr: any[]) =>
            i === arr.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
          )
        : [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];

      // 2. Tools with cache_control on the last tool (tools are sent every request)
      const toolsWithCache = [
        { type: 'web_search_20250305', name: 'web_search' } as Anthropic.WebSearchTool20250305,
        ...body.tools.slice(0, -1) as Anthropic.Tool[],
        ...(body.tools.length > 0 ? [{
          ...body.tools[body.tools.length - 1],
          cache_control: { type: 'ephemeral' },
        } as Anthropic.Tool] : []),
      ];

      // 3. Messages with cache_control on earlier turns (only last user message changes)
      // Cache the second-to-last message if there are enough messages
      const messagesWithCache = validMessages.map((msg, i, arr) => {
        // Add cache breakpoint to message before the last user message
        // This caches all the earlier conversation history
        if (arr.length >= 3 && i === arr.length - 2) {
          return {
            ...msg,
            content: Array.isArray(msg.content)
              ? msg.content.map((block: any, j: number, blocks: any[]) =>
                  j === blocks.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
                )
              : [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
          };
        }
        return msg;
      });

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemWithCache,
        messages: messagesWithCache as Anthropic.MessageParam[],
        tools: toolsWithCache,
        // Pass through tool_choice to force tool use when requested
        // 'any' = Claude MUST use a tool, 'auto' = Claude decides
        ...(body.tool_choice && { tool_choice: body.tool_choice }),
      });

      const elapsed = Date.now() - startTime;
      console.log(`[HttpServer] Claude Tools API responded in ${elapsed}ms, stop_reason: ${response.stop_reason}`);

      // DEBUG: Log content block structure to identify duplicate sources
      const textBlockCount = response.content.filter((b: any) => b.type === 'text').length;
      const toolUseCount = response.content.filter((b: any) => b.type === 'tool_use').length;
      const serverToolCount = response.content.filter((b: any) => b.type === 'server_tool_use').length;
      console.log(`[HttpServer] Response blocks: ${textBlockCount} text, ${toolUseCount} tool_use, ${serverToolCount} server_tool_use`);


      // Extract token counts in all four kinds.
      const rawUsage: any = response.usage || {};
      const tokens: TokenCounts = {
        inputTokens:         rawUsage.input_tokens                  || 0,
        outputTokens:        rawUsage.output_tokens                 || 0,
        cacheReadTokens:     rawUsage.cache_read_input_tokens       || 0,
        cacheCreationTokens: rawUsage.cache_creation_input_tokens   || 0,
      };

      // Log cache stats to verify caching is working
      if (tokens.cacheCreationTokens > 0 || tokens.cacheReadTokens > 0) {
        console.log(`[HttpServer] CACHE: write=${tokens.cacheCreationTokens}, read=${tokens.cacheReadTokens} (${tokens.cacheReadTokens > 0 ? 'HIT' : 'MISS'})`);
      } else {
        console.log(`[HttpServer] CACHE: no cache activity (tokens: ${tokens.inputTokens} in, ${tokens.outputTokens} out)`);
      }

      // Count web searches (billed at $0.01 per search = 1 cent)
      const webSearchCount = response.content.filter(
        (block) => block.type === 'server_tool_use' && (block as { name?: string }).name === 'web_search'
      ).length;
      const webSearchCostCents = webSearchCount * 1; // $0.01 per search

      // Compute cost once, using the shared pricing module.
      const tokenCostCents = calculateCost(model, tokens);
      const costCents = tokenCostCents + webSearchCostCents;

      if (webSearchCount > 0) {
        console.log(`[HttpServer] Web searches: ${webSearchCount}, search cost: ${webSearchCostCents}¢, token cost: ${tokenCostCents}¢`);
      }

      const tokenUsage: TokenUsage = {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens,
        model,
        costCents,
      };

      // Resolve userId: the verified JWT claim in prod; the dev-local sentinel in dev bypass.
      const context = readContextHeaders(c);
      const userId = token
        ? UsageService.extractUserIdFromToken(token)
        : (isDev ? DEV_LOCAL_USER_ID : null);

      // Track usage and get updated balance
      let newBalanceCents = 0;
      if (userId) {
        const anthropicRequestId = (response as any)?.id ?? null;
        // Under owner-pays the cost lands on the server owner, not necessarily
        // `userId` (the actor). trackUsage resolves and returns the billed user
        // so we report the balance that actually changed.
        let billedUserId = userId;
        try {
          const r = await trackUsage({
            userId, model, tokens, costCents, context, anthropicRequestId,
          });
          billedUserId = r.billedUserId;
        } catch (err) {
          // Log but do NOT fail the response — the user already got their Claude answer.
          console.error('[HttpServer] trackUsage failed', err);
        }

        // Fetch the post-deduct balance (of the billed user) for the response —
        // primary-key lookup, trivially fast.
        try {
          const [sub] = await db
            .select({ b: subscriptions.creditBalanceCents })
            .from(subscriptions)
            .where(eq(subscriptions.userId, billedUserId))
            .limit(1);
          // creditBalanceCents is numeric(12,4) — Drizzle returns it as a string.
          newBalanceCents = sub?.b !== undefined ? Number(sub.b) : 0;
        } catch (err) {
          console.error('[HttpServer] failed to read post-deduct balance', err);
          // Leave newBalanceCents as-is (0) rather than fail the response.
        }

        console.log(
          `[HttpServer] usage model=${model} user=${userId.substring(0, 8)} server=${context.serverId ?? '-'} ` +
          `tokens in=${tokens.inputTokens} out=${tokens.outputTokens} cr=${tokens.cacheReadTokens} cc=${tokens.cacheCreationTokens} ` +
          `cost=${costCents.toFixed(4)}¢`,
        );
      }

      // Return response with cost info for UI display
      return c.json({
        content: response.content,
        stop_reason: response.stop_reason,
        usage: {
          input_tokens: tokens.inputTokens,
          output_tokens: tokens.outputTokens,
        },
        model: response.model,
        // Credit info for UI display
        costCents,
        balanceCents: newBalanceCents,
      });

    } catch (error) {
      console.error('[HttpServer] Claude Tools API error:', error);

      if (error instanceof Error) {
        if (error.message.includes('rate_limit')) {
          return c.json({ error: 'Rate limit exceeded - please wait before trying again' }, 429);
        }
        if (error.message.includes('invalid_api_key')) {
          return c.json({ error: 'Server configuration error' }, 500);
        }
      }

      return c.json({
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Usage tracking endpoints
  app.get('/api/usage', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const usage = await UsageService.getCreditBalance(token);

      return c.json(usage);
    } catch (error) {
      console.error('[HttpServer] Usage retrieval error:', error);
      return c.json({ error: 'Failed to get usage' }, 500);
    }
  });

  // ============================================================================
  // Billing Endpoints
  // ============================================================================

  // Get available plans
  app.get('/api/plans', async (c) => {
    try {
      const plans = await UsageService.getPlans();
      return c.json({ plans });
    } catch (error) {
      console.error('[HttpServer] Failed to get plans:', error);
      return c.json({ error: 'Failed to get plans' }, 500);
    }
  });

  // Get current subscription (credit-based)
  app.get('/api/billing/subscription', async (c) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const userAgent = c.req.header('user-agent') || 'unknown';

    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        console.warn(`[HttpServer] /api/billing/subscription - No auth header | IP: ${ip} | UA: ${userAgent.substring(0, 50)}`);
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const tokenPreview = token.substring(0, 20) + '...';

      const balance = await UsageService.getCreditBalance(token);

      // Get plan config for monthly credits (fallback to free if plan not found)
      const planConfig = UsageService.PLAN_CONFIG[balance.plan] || UsageService.PLAN_CONFIG.free;
      if (!UsageService.PLAN_CONFIG[balance.plan]) {
        console.warn(`[HttpServer] Unknown plan "${balance.plan}" for user, falling back to free`);
      }

      // Calculate percent used (as percentage of monthly credits spent)
      const percentUsed = planConfig.monthlyCreditsCents > 0
        ? Math.round((balance.periodSpentCents / planConfig.monthlyCreditsCents) * 100)
        : 0;

      // Count user's servers and check admin status
      const userId = await extractUserIdFromToken(token);
      let serverCount = 0;
      let billingIsAdmin = false;
      if (userId) {
        const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(servers).where(eq(servers.ownerId, userId));
        serverCount = Number(countResult?.count ?? 0);
        billingIsAdmin = await UsageService.isAdmin(userId);
      }

      // Fetch payment method details if customer exists
      let paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null = null;
      if (balance.hasPaymentMethod) {
        const subscription = await UsageService.getSubscriptionByUserId(userId!);
        if (subscription?.stripeCustomerId) {
          paymentMethod = await StripeService.getPaymentMethod(subscription.stripeCustomerId);
        }
      }

      return c.json({
        plan: balance.plan,
        // Credit-based fields (in cents)
        creditBalanceCents: balance.balanceCents,
        monthlyCreditsCents: planConfig.monthlyCreditsCents,
        periodSpentCents: balance.periodSpentCents,
        percentUsed,
        periodStart: balance.periodStart.toISOString(),
        periodEnd: balance.periodEnd.toISOString(),
        stripeConfigured: StripeService.isStripeConfigured(),
        hasPaymentMethod: balance.hasPaymentMethod,
        paymentMethod,
        // Server limits (admins get unlimited)
        maxServers: billingIsAdmin ? 999 : planConfig.maxServers,
        serverCount,
      });
    } catch (error) {
      const authHeader = c.req.header('Authorization');
      const tokenPreview = authHeader ? authHeader.substring(7, 27) + '...' : 'none';
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[HttpServer] /api/billing/subscription FAILED | IP: ${ip} | UA: ${userAgent.substring(0, 50)} | Token: ${tokenPreview} | Error: ${message}`);
      if (message === 'Invalid token') {
        return c.json({ error: 'Invalid token' }, 401);
      }
      return c.json({ error: 'Failed to get subscription' }, 500);
    }
  });

  // Create Stripe checkout session
  app.post('/api/billing/checkout', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      if (!StripeService.isStripeConfigured()) {
        return c.json({ error: 'Stripe is not configured' }, 503);
      }

      const body = await c.req.json() as {
        planId: PlanId;
        successUrl: string;
        cancelUrl: string;
      };

      if (!body.planId || !body.successUrl || !body.cancelUrl) {
        return c.json({ error: 'Missing required fields: planId, successUrl, cancelUrl' }, 400);
      }

      const checkoutUrl = await StripeService.createCheckoutSession({
        userId,
        planId: body.planId,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      });

      return c.json({ url: checkoutUrl });
    } catch (error) {
      console.error('[HttpServer] Checkout error:', error);
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to create checkout session'
      }, 500);
    }
  });

  // Create Stripe customer portal session
  app.post('/api/billing/portal', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      if (!StripeService.isStripeConfigured()) {
        return c.json({ error: 'Stripe is not configured' }, 503);
      }

      const body = await c.req.json() as { returnUrl: string };
      if (!body.returnUrl) {
        return c.json({ error: 'Missing required field: returnUrl' }, 400);
      }

      const portalUrl = await StripeService.createPortalSession(userId, body.returnUrl);
      return c.json({ url: portalUrl });
    } catch (error) {
      console.error('[HttpServer] Portal error:', error);
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to create portal session'
      }, 500);
    }
  });

  // Get available credit packs
  app.get('/api/billing/credit-packs', async (c) => {
    return c.json({ packs: StripeService.CREDIT_PACKS });
  });

  // Create credit top-up checkout session
  app.post('/api/billing/topup', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const body = await c.req.json() as {
        packId: string;
        successUrl: string;
        cancelUrl: string;
      };

      if (!body.packId || !body.successUrl || !body.cancelUrl) {
        return c.json({ error: 'Missing required fields: packId, successUrl, cancelUrl' }, 400);
      }

      const topUpUrl = await StripeService.createTopUpSession({
        userId,
        packId: body.packId as StripeService.CreditPackId,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      });

      return c.json({ url: topUpUrl });
    } catch (error) {
      console.error('[HttpServer] Top-up error:', error);
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to create top-up session'
      }, 500);
    }
  });

  // Sync Stripe customer by email (fallback if webhook was delayed)
  app.post('/api/billing/sync', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      if (!StripeService.isStripeConfigured()) {
        return c.json({ error: 'Stripe is not configured' }, 503);
      }

      // Get user email
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (!user?.email) {
        return c.json({ error: 'User email not found' }, 404);
      }

      // Try to find and sync Stripe customer
      const customerId = await StripeService.syncCustomerByEmail(userId, user.email);
      return c.json({ hasPaymentMethod: !!customerId });
    } catch (error) {
      console.error('[HttpServer] Billing sync error:', error);
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to sync billing'
      }, 500);
    }
  });

  // Comprehensive usage breakdown for the authenticated user, scoped to the
  // current billing period. Powers the "Usage" tables on the Settings page.
  // Reuses the same getBillingPeriod() window as /api/billing/subscription so
  // the totals reconcile with the "Spent This Period" figure shown there.
  app.get('/api/billing/usage-breakdown', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const { start, end } = UsageService.getBillingPeriod();
      // Scope strictly to this user's own events on servers THIS user owns.
      //  - userIds: events billed to this user (under owner-pays, userId == owner)
      //  - ownedBy: only servers currently owned by this user — this is what
      //    guarantees the report never shows a server you don't own. It drops
      //    legacy pre-cutover events that were actor-billed onto someone else's
      //    server (e.g. a collaborator's workspace before owner-pays went live).
      //  - excludePreCutover: drops the synthetic 'pre-cutover-rollup' summary row.
      const filter = {
        start,
        end,
        userIds: [userId],
        ownedBy: userId,
        excludePreCutover: true,
      };

      const [byJob, byServer, byDay, series] = await Promise.all([
        UsageReportService.getBreakdownByTask(filter),
        UsageReportService.getBreakdownByServer(filter),
        UsageReportService.getBreakdownByDay(filter),
        // Zero-filled daily series (every day in the period, $0 on idle days) to
        // drive the usage graph — distinct from byDay, which lists only active
        // days for the table.
        UsageReportService.getDailyTotals(filter, 'day'),
      ]);

      return c.json({
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        byJob,
        byServer,
        byDay,
        series,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[HttpServer] /api/billing/usage-breakdown FAILED | Error: ${message}`);
      if (message === 'Invalid token') {
        return c.json({ error: 'Invalid token' }, 401);
      }
      return c.json({ error: 'Failed to get usage breakdown' }, 500);
    }
  });

  // Stripe webhook endpoint
  app.post('/api/stripe/webhook', async (c) => {
    try {
      const signature = c.req.header('stripe-signature');
      if (!signature) {
        return c.json({ error: 'Missing stripe-signature header' }, 400);
      }

      // Get raw body for signature verification
      const rawBody = await c.req.text();

      const result = await StripeService.handleWebhook(rawBody, signature);

      if (result.success) {
        return c.json({ received: true, message: result.message });
      } else {
        return c.json({ error: result.message }, 400);
      }
    } catch (error) {
      console.error('[HttpServer] Webhook error:', error);
      return c.json({ error: 'Webhook handler failed' }, 500);
    }
  });

  // ============================================================================
  // Admin Endpoints
  // ============================================================================

  // Grant credits to a user (admin only)
  app.post('/api/admin/grant-credits', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const adminUserId = await extractUserIdFromToken(token);
      if (!adminUserId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const body = await c.req.json() as {
        userId: string;
        amount: number;
        reason?: string;
      };

      if (!body.userId || !body.amount) {
        return c.json({ error: 'Missing required fields: userId, amount' }, 400);
      }

      const result = await UsageService.grantCredits(
        adminUserId,
        body.userId,
        body.amount,
        body.reason
      );

      if (!result.success) {
        return c.json({ error: result.error }, result.error?.includes('Unauthorized') ? 403 : 400);
      }

      return c.json({ success: true, newBalanceCents: result.newBalanceCents });
    } catch (error) {
      console.error('[HttpServer] Grant credits error:', error);
      return c.json({ error: 'Failed to grant credits' }, 500);
    }
  });

  // Get user credits (admin only)
  app.get('/api/admin/user/:userId/credits', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const adminUserId = await extractUserIdFromToken(token);
      if (!adminUserId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Check admin
      const isAdminUser = await UsageService.isAdmin(adminUserId);
      if (!isAdminUser) {
        return c.json({ error: 'Unauthorized - admin access required' }, 403);
      }

      const targetUserId = c.req.param('userId');
      const credits = await UsageService.getUserCredits(targetUserId);

      if (!credits) {
        return c.json({ error: 'User not found' }, 404);
      }

      return c.json(credits);
    } catch (error) {
      console.error('[HttpServer] Get user credits error:', error);
      return c.json({ error: 'Failed to get user credits' }, 500);
    }
  });

  // List all users with usage (admin only)
  app.get('/api/admin/users', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const adminUserId = await extractUserIdFromToken(token);
      if (!adminUserId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Check admin
      const isAdminUser = await UsageService.isAdmin(adminUserId);
      if (!isAdminUser) {
        return c.json({ error: 'Unauthorized - admin access required' }, 403);
      }

      const limit = parseInt(c.req.query('limit') || '50');
      const offset = parseInt(c.req.query('offset') || '0');

      const users = await UsageService.listUsersWithUsage(limit, offset);

      return c.json({ users });
    } catch (error) {
      console.error('[HttpServer] List users error:', error);
      return c.json({ error: 'Failed to list users' }, 500);
    }
  });

  // Check if current user is admin
  app.get('/api/admin/check', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const isAdminUser = await UsageService.isAdmin(userId);

      return c.json({ isAdmin: isAdminUser });
    } catch (error) {
      console.error('[HttpServer] Admin check error:', error);
      return c.json({ error: 'Failed to check admin status' }, 500);
    }
  });

  // ============================================================================
  // /tests Harness Cases — shared editable test suite
  // ============================================================================
  // GET is open to any authenticated user. Writes (POST/PUT/DELETE) are gated
  // by the global `adminUsers` flag (same as /api/admin/*) so a per-workspace
  // admin can't mutate the global suite from a workspace they're admin in.

  const HARNESS_LIMITS = { label: 200, prompt: 8 * 1024, expectedOutcome: 16 * 1024 } as const;

  const parseHarnessBody = async (
    c: Context,
  ): Promise<
    | { ok: true; value: { label: string; prompt: string; expectedOutcome: string } }
    | { ok: false; error: string }
  > => {
    let raw: any;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, error: 'Invalid JSON body' };
    }
    const labelRaw = typeof raw?.label === 'string' ? raw.label.trim() : '';
    const promptRaw = typeof raw?.prompt === 'string' ? raw.prompt.trim() : '';
    const expectedRaw =
      typeof raw?.expectedOutcome === 'string' ? raw.expectedOutcome.trim() : '';
    if (!labelRaw) return { ok: false, error: 'label is required' };
    if (!promptRaw) return { ok: false, error: 'prompt is required' };
    if (!expectedRaw) return { ok: false, error: 'expectedOutcome is required' };
    if (labelRaw.length > HARNESS_LIMITS.label)
      return { ok: false, error: `label exceeds ${HARNESS_LIMITS.label} chars` };
    if (promptRaw.length > HARNESS_LIMITS.prompt)
      return { ok: false, error: `prompt exceeds ${HARNESS_LIMITS.prompt} chars` };
    if (expectedRaw.length > HARNESS_LIMITS.expectedOutcome)
      return { ok: false, error: `expectedOutcome exceeds ${HARNESS_LIMITS.expectedOutcome} chars` };
    return { ok: true, value: { label: labelRaw, prompt: promptRaw, expectedOutcome: expectedRaw } };
  };

  const harnessToDTO = (row: {
    id: string;
    label: string;
    prompt: string;
    expectedOutcome: string;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) => ({
    id: row.id,
    label: row.label,
    prompt: row.prompt,
    expectedOutcome: row.expectedOutcome,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  /** Returns the user id of an authenticated caller, or a Response 401. */
  const harnessRequireUser = async (c: Context): Promise<string | Response> => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const userId = await extractUserIdFromToken(authHeader.slice(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    return userId;
  };

  /** Like harnessRequireUser but also enforces global admin. */
  const harnessRequireAdmin = async (c: Context): Promise<string | Response> => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    if (!(await UsageService.isAdmin(userIdOrRes))) {
      return c.json({ error: 'Admin only' }, 403);
    }
    return userIdOrRes;
  };

  app.get('/api/harness-cases', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const rows = await db.select().from(harnessCases).orderBy(asc(harnessCases.createdAt));
    return c.json({ data: rows.map(harnessToDTO) });
  });

  app.post('/api/harness-cases', async (c) => {
    const userIdOrRes = await harnessRequireAdmin(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const parsed = await parseHarnessBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const now = new Date();
    const [row] = await db
      .insert(harnessCases)
      .values({
        id: crypto.randomUUID(),
        label: parsed.value.label,
        prompt: parsed.value.prompt,
        expectedOutcome: parsed.value.expectedOutcome,
        createdBy: userIdOrRes,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return c.json({ data: harnessToDTO(row) }, 201);
  });

  app.put('/api/harness-cases/:id', async (c) => {
    const userIdOrRes = await harnessRequireAdmin(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'id is required' }, 400);
    const parsed = await parseHarnessBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const rows = await db
      .update(harnessCases)
      .set({
        label: parsed.value.label,
        prompt: parsed.value.prompt,
        expectedOutcome: parsed.value.expectedOutcome,
        updatedAt: new Date(),
      })
      .where(eq(harnessCases.id, id))
      .returning();
    if (rows.length === 0) return c.json({ error: 'Case not found' }, 404);
    return c.json({ data: harnessToDTO(rows[0]) });
  });

  app.delete('/api/harness-cases/:id', async (c) => {
    const userIdOrRes = await harnessRequireAdmin(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'id is required' }, 400);
    const rows = await db
      .delete(harnessCases)
      .where(eq(harnessCases.id, id))
      .returning({ id: harnessCases.id });
    if (rows.length === 0) return c.json({ error: 'Case not found' }, 404);
    return c.json({ ok: true });
  });

  // ============================================================================
  // Invite Code Endpoints
  // ============================================================================

  // Get user's invite codes
  app.get('/api/invite/codes', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const codes = await InviteService.getUserInviteCodes(userId);
      return c.json({ codes });
    } catch (error) {
      console.error('[HttpServer] Get invite codes error:', error);
      return c.json({ error: 'Failed to get invite codes' }, 500);
    }
  });

  // Check if user is activated
  app.get('/api/invite/status', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const isActivated = await InviteService.isUserActivated(userId);
      return c.json({ isActivated });
    } catch (error) {
      console.error('[HttpServer] Get invite status error:', error);
      return c.json({ error: 'Failed to get invite status' }, 500);
    }
  });

  // Use an invite code to activate account
  app.post('/api/invite/use', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const body = await c.req.json() as { code: string };
      if (!body.code) {
        return c.json({ error: 'Missing invite code' }, 400);
      }

      const result = await InviteService.useInviteCode(body.code, userId);

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Use invite code error:', error);
      return c.json({ error: 'Failed to use invite code' }, 500);
    }
  });

  // Admin: Activate a user (bypass invite code)
  app.post('/api/admin/invite/activate', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const adminUserId = await extractUserIdFromToken(token);
      if (!adminUserId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Check admin
      const isAdminUser = await UsageService.isAdmin(adminUserId);
      if (!isAdminUser) {
        return c.json({ error: 'Unauthorized - admin access required' }, 403);
      }

      const body = await c.req.json() as { userId: string };
      if (!body.userId) {
        return c.json({ error: 'Missing userId' }, 400);
      }

      const success = await InviteService.activateUser(body.userId);

      if (!success) {
        return c.json({ error: 'User not found' }, 404);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Admin activate user error:', error);
      return c.json({ error: 'Failed to activate user' }, 500);
    }
  });

  // Admin: Generate additional invite codes for a user
  app.post('/api/admin/invite/generate', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      const adminUserId = await extractUserIdFromToken(token);
      if (!adminUserId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Check admin
      const isAdminUser = await UsageService.isAdmin(adminUserId);
      if (!isAdminUser) {
        return c.json({ error: 'Unauthorized - admin access required' }, 403);
      }

      const body = await c.req.json() as { userId: string; count?: number };
      if (!body.userId) {
        return c.json({ error: 'Missing userId' }, 400);
      }

      const codes = await InviteService.adminGenerateCodes(body.userId, body.count || 5);

      return c.json({ codes });
    } catch (error) {
      console.error('[HttpServer] Admin generate codes error:', error);
      return c.json({ error: 'Failed to generate codes' }, 500);
    }
  });

  // Admin: Set the latest server version (called by deploy script)
  app.post('/api/admin/set-server-version', async (c) => {
    try {
      const deploySecret = process.env.DEPLOY_SECRET;
      if (!deploySecret) {
        return c.json({ error: 'DEPLOY_SECRET not configured' }, 500);
      }
      const authHeader = c.req.header('Authorization');
      if (authHeader !== `Bearer ${deploySecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const body = await c.req.json() as { version?: string; imageRef?: string };
      if (!body.version || typeof body.version !== 'string') {
        return c.json({ error: 'Missing version' }, 400);
      }
      await setLatestServerVersion(body.version);
      // Store the full image ref so new machines use the exact deployed image
      if (body.imageRef && typeof body.imageRef === 'string') {
        await db.insert(systemSettings).values({ key: 'latest_server_image', value: body.imageRef }).onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: body.imageRef, updatedAt: new Date() },
        });
        console.log(`[HttpServer] Latest server image set to: ${body.imageRef}`);
      }
      console.log(`[HttpServer] Latest server version set to: ${body.version}`);
      return c.json({ success: true, version: body.version, imageRef: body.imageRef });
    } catch (error) {
      console.error('[HttpServer] Set server version error:', error);
      return c.json({ error: 'Failed to set server version' }, 500);
    }
  });

  // Admin: Get the latest server version and image ref
  app.get('/api/admin/server-version', async (c) => {
    try {
      const deploySecret = process.env.DEPLOY_SECRET;
      if (!deploySecret) {
        return c.json({ error: 'DEPLOY_SECRET not configured' }, 500);
      }
      const authHeader = c.req.header('Authorization');
      if (authHeader !== `Bearer ${deploySecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const version = await getLatestServerVersion();
      const [imageRow] = await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, 'latest_server_image'));
      return c.json({ version, imageRef: imageRow?.value ?? null });
    } catch (error) {
      console.error('[HttpServer] Get server version error:', error);
      return c.json({ error: 'Failed to get server version' }, 500);
    }
  });

  // List remote servers that still live on the legacy shared Fly app
  // (fly_app_name IS NULL). Drives the bulk per-tenant migration runner.
  app.get('/api/admin/legacy-workspaces', async (c) => {
    try {
      const deploySecret = process.env.DEPLOY_SECRET;
      if (!deploySecret) {
        return c.json({ error: 'DEPLOY_SECRET not configured' }, 500);
      }
      const authHeader = c.req.header('Authorization');
      if (authHeader !== `Bearer ${deploySecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const rows = await ServerService.listLegacyWorkspaceServerIds();
      return c.json({ servers: rows });
    } catch (error) {
      console.error('[HttpServer] List legacy workspaces error:', error);
      return c.json({ error: 'Failed to list legacy workspaces' }, 500);
    }
  });

  // Migrate one legacy workspace from the shared Fly app to its own per-tenant
  // app + 6PN network. See docs/per-app-isolation-migration.md. Synchronous —
  // takes ~2–3 minutes per workspace including snapshot + restore + health.
  app.post('/api/admin/migrate-workspace/:serverId', async (c) => {
    try {
      const deploySecret = process.env.DEPLOY_SECRET;
      if (!deploySecret) {
        return c.json({ error: 'DEPLOY_SECRET not configured' }, 500);
      }
      const authHeader = c.req.header('Authorization');
      if (authHeader !== `Bearer ${deploySecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const serverId = c.req.param('serverId');
      if (!serverId) {
        return c.json({ error: 'serverId required' }, 400);
      }

      const result = await ServerService.migrateWorkspaceToOwnApp(serverId);
      return c.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[HttpServer] Migrate workspace error:`, error);
      return c.json({ success: false, error: message }, 500);
    }
  });

  // Distinct list of per-tenant Fly app names across the fleet — drives the
  // deploy script's per-app fan-out so that an image update reaches every
  // workspace app, not just the legacy shared one (see
  // docs/per-app-isolation-migration.md). Legacy rows with fly_app_name=NULL
  // are excluded here; the deploy script handles the legacy shared app
  // directly via the env-default it built against.
  app.get('/api/admin/all-workspace-apps', async (c) => {
    try {
      const deploySecret = process.env.DEPLOY_SECRET;
      if (!deploySecret) {
        return c.json({ error: 'DEPLOY_SECRET not configured' }, 500);
      }
      const authHeader = c.req.header('Authorization');
      if (authHeader !== `Bearer ${deploySecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const rows = await db
        .selectDistinct({ flyAppName: servers.flyAppName })
        .from(servers)
        .where(and(
          eq(servers.deploymentType, 'remote'),
          isNotNull(servers.flyAppName),
        ));
      const apps = rows.map(r => r.flyAppName).filter((x): x is string => !!x);
      return c.json({ apps });
    } catch (error) {
      console.error('[HttpServer] List workspace apps error:', error);
      return c.json({ error: 'Failed to list workspace apps' }, 500);
    }
  });

  // Backfill tunnel DNS records for all remote servers
  app.post('/api/admin/backfill-tunnel-dns', async (c) => {
    try {
      const deploySecret = process.env.DEPLOY_SECRET;
      if (!deploySecret) {
        return c.json({ error: 'DEPLOY_SECRET not configured' }, 500);
      }
      const authHeader = c.req.header('Authorization');
      if (authHeader !== `Bearer ${deploySecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      // Find all remote servers with machineIds
      const remoteServers = await db
        .select({ id: servers.id, machineId: servers.machineId, name: servers.name })
        .from(servers)
        .where(eq(servers.deploymentType, 'remote'));

      const withMachine = remoteServers.filter(s => s.machineId);
      console.log(`[HttpServer] Backfilling tunnel DNS for ${withMachine.length} remote servers (${remoteServers.length} total remote)`);

      const results: Array<{ serverId: string; machineId: string; name: string | null; status: string; warnings?: string[] }> = [];
      for (const server of withMachine) {
        try {
          const result = await ServerService.ensureServerTunnelConnector(server.id);
          if (!result) {
            results.push({
              serverId: server.id,
              machineId: server.machineId!,
              name: server.name,
              status: 'skipped',
            });
            console.log(`[HttpServer] Backfill ${server.id} (${server.machineId}): skipped`);
            continue;
          }
          // Per-server status reflects partial success: any non-fatal warning
          // collected by ensureServerTunnelConnector (e.g. allocateIPs failure
          // for a per-tenant workspace) is surfaced here so the operator
          // doesn't see a blanket "ok" when public ingress wasn't actually
          // healed.
          const hasWarnings = result.warnings.length > 0;
          results.push({
            serverId: server.id,
            machineId: server.machineId!,
            name: server.name,
            status: hasWarnings
              ? `partial (tunnel=${result.tunnelId})`
              : `ok (tunnel=${result.tunnelId})`,
            warnings: hasWarnings ? result.warnings : undefined,
          });
          console.log(
            `[HttpServer] Backfill ${server.id} (${server.machineId}): ${hasWarnings ? `partial (${result.warnings.length} warnings)` : 'ok'}`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({
            serverId: server.id,
            machineId: server.machineId!,
            name: server.name,
            status: `error: ${msg}`,
          });
          console.error(`[HttpServer] Backfill ${server.id} failed:`, error);
        }
      }

      return c.json({ success: true, total: withMachine.length, results });
    } catch (error) {
      console.error('[HttpServer] Backfill tunnel DNS error:', error);
      return c.json({ error: 'Failed to backfill' }, 500);
    }
  });

  // ==========================================================================
  // Server Invite Links -- Public Routes
  // ==========================================================================

  // Get public info about an invite link (no auth required)
  app.get('/api/invite/:code/info', async (c) => {
    try {
      const code = c.req.param('code');
      const result = await ServerService.getInviteLinkInfo(code);
      if (!result.success) {
        return c.json({ error: result.error }, 404);
      }
      return c.json({ success: true, invite: result.invite });
    } catch (error) {
      console.error('[HttpServer] Get invite link info error:', error);
      return c.json({ error: 'Failed to get invite info' }, 500);
    }
  });

  // Accept an invite link (auth required)
  app.post('/api/invite/:code/accept', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const code = c.req.param('code');
      const result = await ServerService.acceptInviteLink(code, userId);
      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }
      return c.json({ success: true, serverId: result.serverId });
    } catch (error) {
      console.error('[HttpServer] Accept invite link error:', error);
      return c.json({ error: 'Failed to accept invite' }, 500);
    }
  });

  // ==========================================================================
  // Server Management (authenticated)
  // ==========================================================================

  // Resolve a task share-link id to the server + channel + task that owns it.
  //
  // Links are minted client-side as `app.runhq.io/task/<shortId>` (the first 8
  // hex of the task UUID); old links use `/?todo=<full-uuid>`. Neither carries
  // server context, so the web app asks the cloud — which mirrors every task in
  // workspace_tasks — to resolve the id before routing. Access is gated to
  // servers the user can actually reach (the same set as GET /api/servers); a
  // task on a server the user can't see returns 404 (not 403) so we never leak
  // which server a task lives on. Returning channelId lets the client route
  // straight to the owning channel, avoiding the store-hydration race in the
  // `/server/:id/todo/:id` path.
  app.get('/api/tasks/:shortId/resolve', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      let userId: string | null = null;
      if (authHeader?.startsWith('Bearer ')) {
        userId = await extractUserIdFromToken(authHeader.substring(7));
      }
      if (!userId && process.env.NODE_ENV !== 'production') {
        const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
        userId = firstUser?.id || null;
      }
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const query = WorkspaceTaskService.parseTaskShareId(c.req.param('shortId'));
      if (!query) {
        return c.json({ error: 'Invalid task id' }, 400);
      }

      const candidates = await WorkspaceTaskService.resolveTaskCandidates(query);
      const userServers = await ServerService.getUserServers(userId);
      const accessible = new Set(userServers.map((s) => s.id));
      const { resolved, ambiguous } = WorkspaceTaskService.selectResolvedTask(
        candidates,
        accessible,
        query,
      );
      if (ambiguous) {
        console.warn(
          `[HttpServer] Ambiguous task share id "${c.req.param('shortId')}" → ${resolved?.taskId}`,
        );
      }
      if (!resolved) {
        return c.json({ error: 'Task not found' }, 404);
      }

      return c.json({ data: resolved });
    } catch (error) {
      console.error('[HttpServer] Resolve task error:', error);
      return c.json({ error: 'Failed to resolve task' }, 500);
    }
  });

  // List user's servers (with server status)
  app.get('/api/servers', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      let userId: string | null = null;

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        userId = await extractUserIdFromToken(token);
        if (userId) {
          console.log('[HttpServer] Server list: authenticated user:', userId);
        } else {
          console.log('[HttpServer] Server list: token extraction failed');
        }
      } else {
        console.log('[HttpServer] Server list: no auth header');
      }

      // Dev bypass: use first user if no valid token in development
      // Must match the same bypass in POST /api/servers to avoid owner mismatch
      if (!userId && process.env.NODE_ENV !== 'production') {
        const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
        userId = firstUser?.id || null;
        if (userId) {
          console.log('[HttpServer] Dev mode bypass: using first user for server list:', userId);
        }
      }

      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const servers = await ServerService.getUserServers(userId);

      // Fetch live machine states for all servers with machines.
      //
      // We can't use listMachines() once workspaces are spread across
      // per-tenant Fly apps (see docs/per-app-isolation-migration.md) — a
      // single list call only sees one app. Instead, fetch each server's
      // state in parallel, scoped to its own flyAppName when present (and
      // falling back to the legacy shared app for older rows).
      const machineStateMap: Map<string, string> = new Map();
      const serversWithMachines = servers.filter(w => w.machineId);
      if (serversWithMachines.length > 0) {
        await Promise.all(serversWithMachines.map(async (s) => {
          try {
            const provider = getProvider((s.provider || 'fly') as ProviderId);
            const state = await provider.getMachineState(s.machineId!, s.flyAppName);
            machineStateMap.set(s.machineId!, state);
          } catch (err) {
            // Don't fail the whole request if any one machine can't be reached
            console.warn(`[HttpServer] Could not fetch state for machine ${s.machineId}:`, err);
          }
        }));
      }

      // Transform servers: don't expose hash, but indicate if token exists
      // For remote servers, use the correct provider-specific URL
      const data = servers.map((w) => {
        let serverUrl = w.serverUrl;
        if (w.machineId) {
          const provider = getProvider((w.provider || 'fly') as ProviderId);
          const routingUrl = provider.getRoutingInfo(w.machineId, w.flyAppName).serverUrl;
          if (routingUrl) serverUrl = routingUrl;
        }
        return {
          id: w.id,
          name: w.name,
          role: w.role,
          ownerId: w.ownerId,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          // Deployment type (local or remote)
          deploymentType: w.deploymentType,
          // Token field - hasToken indicates if they can set up a remote server
          hasToken: !!w.tokenHash,
          // Server URL (provider-aware)
          serverUrl,
          status: w.status,
          lastSeen: w.lastSeen,
          // Routing fields for per-machine routing
          machineId: w.machineId,
          // Live machine state (running, stopped, suspended, etc.)
          machineState: w.machineId ? machineStateMap.get(w.machineId) || null : null,
          provider: w.provider || 'fly',
          autoSuspendEnabled: w.autoSuspendEnabled ?? true,
          // Team info
          memberCount: w.memberCount,
          // Custom icon
          iconUrl: w.iconUrl || null,
          // User-specific sort order
          sortOrder: w.sortOrder ?? null,
        };
      });

      // Include server limits for the user's plan (admins get unlimited)
      const subscription = await UsageService.getOrCreateSubscription(userId);
      const planConfig = UsageService.PLAN_CONFIG[subscription.planId as keyof typeof UsageService.PLAN_CONFIG] || UsageService.PLAN_CONFIG.free;
      const listIsAdmin = await UsageService.isAdmin(userId);

      // Count only owned servers (not joined) for limit enforcement
      const ownedCount = data.filter(s => s.ownerId === userId).length;

      return c.json({
        data,
        limits: {
          maxServers: listIsAdmin ? 999 : planConfig.maxServers,
          currentCount: ownedCount,
          planId: subscription.planId,
        },
      });
    } catch (error) {
      console.error('[HttpServer] Get servers error:', error);
      return c.json({ error: 'Failed to get servers' }, 500);
    }
  });

  // Update server sort order for the authenticated user
  app.put('/api/servers/order', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const body = await c.req.json() as { order: Array<{ serverId: string; sortOrder: number }> };
      if (!Array.isArray(body.order)) {
        return c.json({ error: 'order array is required' }, 400);
      }

      // Update sort_order for each server membership in parallel
      await Promise.all(
        body.order.map(({ serverId, sortOrder }) =>
          db.update(serverMembers)
            .set({ sortOrder })
            .where(sql`${serverMembers.serverId} = ${serverId} AND ${serverMembers.userId} = ${userId}`)
        )
      );

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Update server order error:', error);
      return c.json({ error: 'Failed to update server order' }, 500);
    }
  });

  // List available server templates (public, no auth required)
  app.get('/api/templates', async (c) => {
    try {
      const templates = await db
        .select({
          id: serverTemplates.id,
          serverId: serverTemplates.serverId,
          name: serverTemplates.name,
          description: serverTemplates.description,
          iconUrl: serverTemplates.iconUrl,
          sortOrder: serverTemplates.sortOrder,
        })
        .from(serverTemplates)
        .innerJoin(servers, eq(serverTemplates.serverId, servers.id))
        .orderBy(serverTemplates.sortOrder);
      return c.json({ success: true, templates });
    } catch (error) {
      console.error('[HttpServer] Get templates error:', error);
      return c.json({ error: 'Failed to get templates' }, 500);
    }
  });

  // ── Agent Templates (global agent blueprints) ────────────────────────
  app.get('/api/agent-templates', async (c) => {
    try {
      const templates = await db
        .select({
          id: agentTemplates.id,
          name: agentTemplates.name,
          description: agentTemplates.description,
          systemPrompt: agentTemplates.systemPrompt,
          character: agentTemplates.character,
          model: agentTemplates.model,
          enabledTools: agentTemplates.enabledTools,
          startingCommand: agentTemplates.startingCommand,
          jobStartCommand: agentTemplates.jobStartCommand,
          autoStartTasks: agentTemplates.autoStartTasks,
          sortOrder: agentTemplates.sortOrder,
        })
        .from(agentTemplates)
        .orderBy(agentTemplates.sortOrder);
      return c.json({ success: true, templates });
    } catch (error) {
      console.error('[HttpServer] Get agent templates error:', error);
      return c.json({ error: 'Failed to get agent templates' }, 500);
    }
  });

  // Create a new server
  app.post('/api/servers', async (c) => {
    try {
      const settings = await getSettings();
      if (settings.serverCreationDisabled) {
        console.warn('[HttpServer] Server create blocked: kill-switch enabled');
        return c.json({ error: settings.serverCreationDisabledMessage }, 503);
      }

      const authHeader = c.req.header('Authorization');
      let userId: string | null = null;

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        userId = await extractUserIdFromToken(token);
        if (userId) {
          console.log('[HttpServer] Server create: authenticated user:', userId);
        } else {
          console.log('[HttpServer] Server create: token extraction failed');
        }
      } else {
        console.log('[HttpServer] Server create: no auth header');
      }

      // Dev bypass: use first user if no valid token in development
      if (!userId && process.env.NODE_ENV !== 'production') {
        let [firstUser] = await db.select({ id: users.id }).from(users).limit(1);

        // Create a dev user if none exists
        if (!firstUser) {
          console.log('[HttpServer] Dev mode: creating dev user');
          const [newUser] = await db.insert(users).values({
            email: 'dev@localhost',
            name: 'Dev User',
            isActivated: true,
          }).returning({ id: users.id });
          firstUser = newUser;
        }

        userId = firstUser?.id || null;
        if (userId) {
          console.log('[HttpServer] Dev mode bypass: using first user for server creation:', userId);
        }
      }

      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Invite-gating chokepoint: provisioning is the only costly action an
      // unactivated user could trigger. assertActivated is a no-op when
      // REQUIRE_SIGNUP_INVITE is off.
      if (!(await assertActivated(userId))) {
        return c.json({ error: 'activation_required' }, 403);
      }

      const body = await c.req.json();
      const { name, deploymentType, region, tier, templateId, provider: requestedProvider } = body;
      if (!name || typeof name !== 'string') {
        return c.json({ error: 'Server name is required' }, 400);
      }

      // Validate deploymentType
      if (deploymentType && !['local', 'remote'].includes(deploymentType)) {
        return c.json({ error: 'Invalid deployment type' }, 400);
      }

      // Validate and resolve provider
      const providerId = requestedProvider || getDefaultProviderId();
      try {
        const { appendFileSync } = await import('node:fs');
        appendFileSync('/tmp/be-create-server.log', `${new Date().toISOString()} requestedProvider=${requestedProvider ?? '(none)'} providerId=${providerId} tier=${tier ?? '(none)'} bodyKeys=${Object.keys(body).join(',')}\n`);
      } catch {}
      if (requestedProvider && !hasProvider(requestedProvider)) {
        return c.json({ error: `Provider '${requestedProvider}' is not available` }, 400);
      }

      // Validate tier (accepts both new tier names and legacy Fly tier names)
      const validTiers = [
        // New tiers
        'shared-4x-1gb', 'shared-4x-2gb', 'shared-4x-4gb', 'shared-4x-8gb',
        'shared-8x-4gb', 'shared-8x-8gb', 'shared-8x-16gb',
        'perf-2x-4gb', 'perf-2x-8gb', 'perf-2x-16gb',
        'perf-4x-8gb', 'perf-4x-16gb', 'perf-4x-32gb',
        // Legacy tiers
        'micro', 'small', 'medium', 'large', 'xlarge', 'xxlarge',
        'shared-cpu-1x', 'shared-cpu-2x', 'shared-cpu-4x', 'performance-cpu-2x', 'performance-cpu-4x',
      ];
      if (tier && !validTiers.includes(tier)) {
        return c.json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` }, 400);
      }

      // Resolve region: 'auto' (or empty for remote deployments) → infer from
      // Cloudflare's CF-IPCountry header so the auto-provisioned signup flow
      // doesn't have to make the user pick a region. Local deployments keep
      // the legacy 'ash' default.
      let resolvedRegion: string;
      if (deploymentType === 'remote' || (region && region !== '')) {
        if (!region || region === 'auto') {
          resolvedRegion = inferRegionFromCountry(c.req.header('cf-ipcountry') ?? c.req.header('CF-IPCountry'));
        } else {
          resolvedRegion = region;
        }
      } else {
        resolvedRegion = region || 'ash';
      }

      // Enforce server limit + tier-vs-plan rules per plan. Admins bypass.
      // Providers with no usage cost (DockerProvider — all tier rates $0)
      // also bypass: plan gating is a billing construct, and free-plan
      // developers must be able to exercise local docker workspaces.
      const userIsAdmin = await UsageService.isAdmin(userId);
      if (!userIsAdmin && UsageService.enforcesPlanLimits(providerId)) {
        const subscription = await UsageService.getOrCreateSubscription(userId);
        const planId = subscription.planId as keyof typeof UsageService.PLAN_CONFIG;
        const planConfig = UsageService.PLAN_CONFIG[planId] || UsageService.PLAN_CONFIG.free;

        const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(servers).where(eq(servers.ownerId, userId));
        const currentCount = Number(countResult?.count ?? 0);
        if (UsageService.hasReachedServerLimit(currentCount, planConfig.maxServers)) {
          return c.json({
            error: 'Server limit reached',
            maxServers: planConfig.maxServers,
            currentCount,
          }, 403);
        }

        // Free plan is locked to the lowest-tier machine. Reject anything else
        // before we hit the provider — surfaces a clear upgrade message rather
        // than a billing/quota failure deeper in.
        if (tier && !UsageService.isTierAllowedForPlan(planId, tier)) {
          return c.json({
            error: `The ${planConfig.name} plan is limited to the ${UsageService.FREE_PLAN_TIER} machine. Upgrade to choose a larger tier.`,
            plan: planId,
            requestedTier: tier,
            allowedTier: UsageService.FREE_PLAN_TIER,
          }, 403);
        }
      }

      // Generate a server ID
      const serverId = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await ServerService.createServer(userId, {
        id: serverId,
        name,
        deploymentType: deploymentType || 'local',
        region: resolvedRegion,
        tier: tier || 'micro',
        provider: providerId,
      });

      // If a template was selected, apply it in the background after server comes online
      if (templateId) {
        ServerService.applyTemplate(serverId, templateId, userId).catch((err) => {
          console.error(`[HttpServer] Failed to apply template ${templateId} to server ${serverId}:`, err);
        });
      }

      // Return server with token (user sees this once to copy to their server)
      // Don't expose the hash
      return c.json({
        success: true,
        server: {
          id: result.id,
          name: result.name,
          ownerId: result.ownerId,
          deploymentType: result.deploymentType,
          serverToken: result.serverToken, // Plaintext token - user copies this
          serverUrl: result.serverUrl,
          status: result.status,
          region: result.region,
          machineId: result.machineId,
          provider: result.provider || 'fly',
          autoSuspendEnabled: result.autoSuspendEnabled ?? true,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        },
      });
    } catch (error) {
      console.error('[HttpServer] Create server error:', error);
      return c.json({ error: 'Failed to create server' }, 500);
    }
  });

  // Get a single server by ID
  app.get('/api/servers/:serverId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      let userId: string | null = null;

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        userId = await extractUserIdFromToken(token);
      }

      // Dev bypass
      if (!userId && process.env.NODE_ENV !== 'production') {
        const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
        userId = firstUser?.id || null;
      }

      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');

      // Check if user has access to this server
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }

      // Return server with server info (don't expose hash)
      let serverUrl = server.serverUrl;
      let volumeSizeGb: number | null = null;
      if (server.machineId) {
        const provider = getProvider((server.provider || 'fly') as ProviderId);
        const routingUrl = provider.getRoutingInfo(server.machineId, server.flyAppName).serverUrl;
        if (routingUrl) serverUrl = routingUrl;

        // Fetch current volume size if volume exists
        if (server.volumeId) {
          try {
            const volume = await provider.getVolume(server.volumeId, server.flyAppName);
            if (volume) volumeSizeGb = volume.sizeGb;
          } catch { /* ignore - volume info is optional */ }
        }
      }
      const provisionEvents = await ServerService.getProvisionEvents(serverId);
      return c.json({
        server: {
          id: server.id,
          name: server.name,
          ownerId: server.ownerId,
          deploymentType: server.deploymentType,
          serverUrl,
          status: server.status,
          provisionStep: server.provisionStep ?? null,
          provisionEvents: provisionEvents.map(e => ({
            step: e.step,
            message: e.message,
            createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
          })),
          lastSeen: server.lastSeen,
          machineId: server.machineId,
          region: server.region,
          provider: server.provider || 'fly',
          tier: server.tier || 'shared-cpu-1x',
          iconUrl: server.iconUrl || null,
          volumeId: server.volumeId || null,
          volumeSizeGb,
          autoSuspendEnabled: server.autoSuspendEnabled ?? true,
          autoSuspendIdleMinutes: server.autoSuspendIdleMinutes ?? 15,
          machineStartedAt: server.machineStartedAt?.toISOString() || null,
          createdAt: server.createdAt,
          updatedAt: server.updatedAt,
        },
      });
    } catch (error) {
      console.error('[HttpServer] Get server error:', error);
      return c.json({ error: 'Failed to get server' }, 500);
    }
  });

  // Get machine usage for a server
  app.get('/api/servers/:serverId/machine-usage', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const usage = await MachineUsageService.getMachineUsage(serverId);
      if (!usage) {
        return c.json({ error: 'Server not found' }, 404);
      }

      return c.json(usage);
    } catch (error) {
      console.error('[HttpServer] Get machine usage error:', error);
      return c.json({ error: 'Failed to get machine usage' }, 500);
    }
  });

  // Get server members
  app.get('/api/servers/:serverId/members', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);
      const members = await ServerService.getServerMembers(serverId);
      return c.json({ members });
    } catch (error) {
      console.error('[HttpServer] Get server members error:', error);
      return c.json({ error: 'Failed to get members' }, 500);
    }
  });

  // Update a server (owner/admin only)
  app.patch('/api/servers/:serverId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { name, iconUrl, autoSuspendEnabled, autoSuspendIdleMinutes } = body as {
        name?: string;
        iconUrl?: string | null;
        autoSuspendEnabled?: boolean;
        autoSuspendIdleMinutes?: number;
      };

      // At least one field must be provided
      if (!name && iconUrl === undefined && autoSuspendEnabled === undefined && autoSuspendIdleMinutes === undefined) {
        return c.json({ error: 'At least one field is required' }, 400);
      }

      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return c.json({ error: 'Name must be a non-empty string' }, 400);
      }

      // Validate iconUrl if provided (can be an emoji string or a data:image/ URL)
      if (iconUrl !== undefined && iconUrl !== null) {
        if (typeof iconUrl !== 'string') {
          return c.json({ error: 'iconUrl must be a string or null' }, 400);
        }
        if (iconUrl.startsWith('data:image/')) {
          if (iconUrl.length > 256 * 1024) {
            return c.json({ error: 'iconUrl exceeds maximum size of 256KB' }, 400);
          }
        } else if (iconUrl.length > 32) {
          return c.json({ error: 'iconUrl emoji must be 32 characters or fewer' }, 400);
        }
      }

      // Validate autoSuspendEnabled if provided
      if (autoSuspendEnabled !== undefined && typeof autoSuspendEnabled !== 'boolean') {
        return c.json({ error: 'autoSuspendEnabled must be a boolean' }, 400);
      }

      // Validate autoSuspendIdleMinutes if provided
      if (autoSuspendIdleMinutes !== undefined) {
        if (typeof autoSuspendIdleMinutes !== 'number' || !Number.isInteger(autoSuspendIdleMinutes) || autoSuspendIdleMinutes < 1 || autoSuspendIdleMinutes > 1440) {
          return c.json({ error: 'autoSuspendIdleMinutes must be an integer between 1 and 1440' }, 400);
        }
      }

      const updateData: { name?: string; iconUrl?: string | null; autoSuspendEnabled?: boolean; autoSuspendIdleMinutes?: number } = {};
      if (name) updateData.name = name.trim();
      if (iconUrl !== undefined) updateData.iconUrl = iconUrl;
      if (autoSuspendEnabled !== undefined) updateData.autoSuspendEnabled = autoSuspendEnabled;
      if (autoSuspendIdleMinutes !== undefined) updateData.autoSuspendIdleMinutes = autoSuspendIdleMinutes;

      const updated = await ServerService.updateServer(serverId, userId, updateData);

      if (!updated) {
        return c.json({ error: 'Failed to update server. Only owner or admin can update.' }, 403);
      }

      return c.json({ success: true, server: updated });
    } catch (error) {
      console.error('[HttpServer] Update server error:', error);
      return c.json({ error: 'Failed to update server' }, 500);
    }
  });

  // Delete a server (owner only)
  app.delete('/api/servers/:serverId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await ServerService.deleteServer(serverId, userId);

      if (!result.success) {
        return c.json({ error: result.error || 'Failed to delete server' }, 400);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Delete server error:', error);
      return c.json({ error: 'Failed to delete server' }, 500);
    }
  });

  // Transfer server ownership (owner only)
  app.post('/api/servers/:serverId/transfer', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { email } = body;

      if (!email || typeof email !== 'string') {
        return c.json({ error: 'Email is required' }, 400);
      }

      const result = await ServerService.transferOwnership(serverId, userId, email);
      if (!result.success) {
        const error = result.error || 'Transfer failed';
        if (error.includes('No account found')) {
          return c.json({ error }, 404);
        }
        if (error.includes('server limit')) {
          return c.json({ error }, 403);
        }
        return c.json({ error }, 400);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Transfer ownership error:', error);
      return c.json({ error: 'Failed to transfer ownership' }, 500);
    }
  });

  // Change server region (owner only)
  app.post('/api/servers/:serverId/change-region', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { region } = body;

      if (!region || typeof region !== 'string') {
        return c.json({ error: 'Region is required' }, 400);
      }

      // Validate the region change request synchronously
      const validation = await ServerService.validateChangeRegion(serverId, userId, region);
      if (!validation.success) {
        return c.json({ error: validation.error }, 400);
      }

      // Set provisioning status immediately to prevent race condition where
      // client reloads and reconnects to the old machine before changeRegion runs
      await ServerService.setServerStatus(serverId, 'provisioning');

      // Start the region change in the background (don't await - it takes minutes)
      // The client will poll server status to track progress
      ServerService.changeRegion(serverId, userId, region).catch((error) => {
        console.error(`[HttpServer] Background region change failed for ${serverId}:`, error);
      });

      return c.json({ success: true, status: 'provisioning' });
    } catch (error) {
      console.error('[HttpServer] Change region error:', error);
      return c.json({ error: 'Failed to change region' }, 500);
    }
  });

  // Change server tier (upgrade/downgrade machine)
  // Validate tier change (pre-check before showing confirmation)
  app.post('/api/servers/:serverId/validate-tier', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { tier } = body;

      if (!tier || typeof tier !== 'string') {
        return c.json({ error: 'Tier is required' }, 400);
      }

      const validation = await ServerService.validateChangeTier(serverId, userId, tier);
      return c.json(validation);
    } catch (error) {
      console.error('[HttpServer] Validate tier error:', error);
      return c.json({ success: false, error: 'Failed to validate tier' }, 500);
    }
  });

  app.post('/api/servers/:serverId/change-tier', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { tier } = body;

      if (!tier || typeof tier !== 'string') {
        return c.json({ error: 'Tier is required' }, 400);
      }

      const validation = await ServerService.validateChangeTier(serverId, userId, tier);
      if (!validation.success) {
        return c.json({ error: validation.error }, 400);
      }

      // Set provisioning status immediately to prevent race condition where
      // client reloads and reconnects to the old machine before changeTier runs
      await ServerService.setServerStatus(serverId, 'provisioning');

      // Start the tier change in the background (don't await - it takes minutes)
      ServerService.changeTier(serverId, userId, tier as any).catch((error) => {
        console.error(`[HttpServer] Background tier change failed for ${serverId}:`, error);
      });

      return c.json({ success: true, status: 'provisioning' });
    } catch (error) {
      console.error('[HttpServer] Change tier error:', error);
      return c.json({ error: 'Failed to change tier' }, 500);
    }
  });

  // Extend server volume (disk) size
  app.post('/api/servers/:serverId/extend-volume', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);
      const body = await c.req.json();
      const { sizeGb } = body;

      if (!sizeGb || typeof sizeGb !== 'number') {
        return c.json({ error: 'sizeGb is required and must be a number' }, 400);
      }

      const result = await ServerService.extendServerVolume(serverId, userId, sizeGb);
      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ success: true, newSizeGb: result.newSizeGb });
    } catch (error) {
      console.error('[HttpServer] Extend volume error:', error);
      return c.json({ error: 'Failed to extend volume' }, 500);
    }
  });

  // Invite member to server
  app.post('/api/servers/:serverId/invite', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { role, serverName } = body;
      let { email, username } = body;

      // Resolve username to email if needed
      if (!email && username) {
        const user = await getUserByUsername(username);
        if (!user?.email) {
          return c.json({ error: 'User not found' }, 404);
        }
        email = user.email;
      }

      if (!email) {
        return c.json({ error: 'Email or username is required' }, 400);
      }

      // Ensure server exists in cloud (create if not)
      const resolvedServerName = serverName || 'Untitled Server';
      await ServerService.ensureServer(serverId, userId, resolvedServerName);

      const result = await ServerService.createInvite(serverId, userId, email, role || 'member');
      if (!result.success) {
        if (result.reason === 'no_permission') {
          return c.json({ error: 'You do not have permission to invite members to this server.' }, 403);
        }
        if (result.reason === 'already_member') {
          return c.json({ error: 'This user is already a member of the server.' }, 409);
        }
        return c.json({ error: 'Failed to create invite' }, 400);
      }

      // Send invite email
      try {
        const [inviter] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        const inviterName = inviter?.name || inviter?.email || 'Someone';
        const CLIENT_URL = process.env.CLIENT_URL || 'https://app.runhq.io';
        const acceptUrl = `${CLIENT_URL}/invite/accept?token=${result.token}`;
        await sendInviteEmail(email, inviterName, resolvedServerName, acceptUrl);
      } catch (emailErr) {
        console.error('[HttpServer] Failed to send invite email:', emailErr);
        // Invite was created successfully, just email failed - don't fail the request
      }

      return c.json({ success: true, invite: { token: result.token, expiresAt: result.expiresAt } });
    } catch (error) {
      console.error('[HttpServer] Invite member error:', error);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Remove member from server
  app.delete('/api/servers/:serverId/members/:memberId', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const memberId = c.req.param('memberId');

      // Support server-token auth (fishtank server proxying self-leave only).
      // The server-token path is constrained to self-leave: the workspace must
      // also forward the requesting user's session JWT as X-Actor-Token, and
      // memberId must match its userId claim. This prevents a leaked server
      // token alone from removing arbitrary members.
      const serverToken = c.req.header('X-Server-Token');
      if (serverToken) {
        const server = await ServerService.getServerByToken(serverToken);
        if (!server || server.id !== serverId) {
          return c.json({ error: 'Invalid server token' }, 401);
        }
        const actorToken = c.req.header('X-Actor-Token');
        if (!actorToken) {
          return c.json({ error: 'Actor token required' }, 401);
        }
        const actor = await ServerSessionService.verifyServerSessionToken(actorToken);
        if (!actor || actor.serverId !== serverId) {
          return c.json({ error: 'Invalid actor token' }, 401);
        }
        if (actor.userId !== memberId) {
          return c.json({ error: 'Server-token path supports self-leave only' }, 403);
        }
        const success = await ServerService.leaveServer(serverId, memberId);
        return c.json({ success });
      }

      // User-token auth (direct API calls)
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Self-removal (Leave Server) vs admin kick
      const success = memberId === userId
        ? await ServerService.leaveServer(serverId, userId)
        : await ServerService.removeMember(serverId, userId, memberId);
      return c.json({ success });
    } catch (error) {
      console.error('[HttpServer] Remove member error:', error);
      return c.json({ error: 'Failed to remove member' }, 500);
    }
  });

  // Ban a member from server
  app.post('/api/servers/:serverId/bans', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { userId: targetUserId, reason, deleteMessageHours } = body;

      if (!targetUserId) {
        return c.json({ error: 'userId is required' }, 400);
      }

      const success = await ServerService.banMember(serverId, userId, targetUserId, reason, deleteMessageHours);
      if (!success) {
        return c.json({ error: 'Failed to ban member' }, 403);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Ban member error:', error);
      return c.json({ error: 'Failed to ban member' }, 500);
    }
  });

  // Unban a member from server
  app.delete('/api/servers/:serverId/bans/:userId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const targetUserId = c.req.param('userId');

      const success = await ServerService.unbanMember(serverId, userId, targetUserId);
      if (!success) {
        return c.json({ error: 'Failed to unban member' }, 403);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Unban member error:', error);
      return c.json({ error: 'Failed to unban member' }, 500);
    }
  });

  // Get server bans
  app.get('/api/servers/:serverId/bans', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);
      const bans = await ServerService.getServerBans(serverId);
      return c.json({ bans });
    } catch (error) {
      console.error('[HttpServer] Get server bans error:', error);
      return c.json({ error: 'Failed to get bans' }, 500);
    }
  });

  // Get pending invites for current user
  app.get('/api/servers/invites/pending', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      // Look up user's email (getUserPendingInvites expects email, not userId)
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.email) {
        return c.json({ invites: [] });
      }

      const invites = await ServerService.getUserPendingInvites(user.email);
      return c.json({ invites });
    } catch (error) {
      console.error('[HttpServer] Get pending invites error:', error);
      return c.json({ error: 'Failed to get invites' }, 500);
    }
  });

  // Get invite info by token (public, no auth required)
  app.get('/api/servers/invites/:token/info', async (c) => {
    try {
      const inviteToken = c.req.param('token');
      const info = await ServerService.getInviteInfo(inviteToken);
      if (!info) {
        return c.json({ error: 'Invite not found' }, 404);
      }
      return c.json(info);
    } catch (error) {
      console.error('[HttpServer] Get invite info error:', error);
      return c.json({ error: 'Failed to get invite info' }, 500);
    }
  });

  // Accept server invite by token
  app.post('/api/servers/invites/:token/accept', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const authToken = authHeader.substring(7);
      const userId = await extractUserIdFromToken(authToken);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const inviteToken = c.req.param('token');
      const result = await ServerService.acceptInvite(inviteToken, userId);
      return c.json({ success: true, serverId: result?.serverId });
    } catch (error) {
      console.error('[HttpServer] Accept invite error:', error);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Accept server invite by serverId
  app.post('/api/servers/:serverId/invite/accept', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const authToken = authHeader.substring(7);
      const userId = await extractUserIdFromToken(authToken);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await ServerService.acceptInviteByServer(serverId, userId);
      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Accept invite by server error:', error);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Decline server invite by serverId
  app.post('/api/servers/:serverId/invite/decline', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const authToken = authHeader.substring(7);
      const userId = await extractUserIdFromToken(authToken);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await ServerService.declineInviteByServer(serverId, userId);
      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Decline invite error:', error);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Get sent invites for a server (pending invites that admins sent to others)
  app.get('/api/servers/:serverId/invites', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const authToken = authHeader.substring(7);
      const userId = await extractUserIdFromToken(authToken);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      if (!(await ServerService.canManageServerMembers(serverId, userId))) {
        return c.json({ error: 'Access denied' }, 403);
      }
      const invites = await ServerService.getServerInvites(serverId);
      return c.json({ invites });
    } catch (error) {
      console.error('[HttpServer] Get server invites error:', error);
      return c.json({ error: 'Failed to get invites' }, 500);
    }
  });

  // Cancel a pending invite
  app.delete('/api/servers/:serverId/invites/:email', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const authToken = authHeader.substring(7);
      const userId = await extractUserIdFromToken(authToken);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const email = decodeURIComponent(c.req.param('email'));
      const success = await ServerService.cancelInvite(serverId, userId, email);
      return c.json({ success });
    } catch (error) {
      console.error('[HttpServer] Cancel invite error:', error);
      return c.json({ error: 'Failed to cancel invite' }, 500);
    }
  });

  // ==========================================================================
  // Server Invite Links (Discord-style shareable links)
  // ==========================================================================

  // Create an invite link
  app.post('/api/servers/:serverId/invite-links', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const body = await c.req.json() as { expiresIn?: number; maxUses?: number; createdBy?: string; serverToken?: string };

      // Support server-token auth: the server has already verified permissions locally
      // Check header first, fall back to body (some proxies strip custom headers)
      const serverToken = c.req.header('X-Server-Token') || body.serverToken;
      if (serverToken) {
        const server = await ServerService.getServerByToken(serverToken);
        if (!server || server.id !== serverId) {
          return c.json({ error: 'Invalid server token' }, 401);
        }
        const result = await ServerService.createInviteLink(serverId, body.createdBy || server.ownerId, {
          expiresIn: body.expiresIn,
          maxUses: body.maxUses,
          skipPermissionCheck: true,
        });
        if (!result.success) {
          return c.json({ error: result.error }, 400);
        }
        return c.json({ success: true, inviteLink: result.inviteLink });
      }

      // Standard user-token auth with cloud-level permission check
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const result = await ServerService.createInviteLink(serverId, userId, {
        expiresIn: body.expiresIn,
        maxUses: body.maxUses,
      });

      if (!result.success) {
        return c.json({ error: result.error }, 403);
      }
      return c.json({ success: true, inviteLink: result.inviteLink });
    } catch (error) {
      console.error('[HttpServer] Create invite link error:', error);
      return c.json({ error: 'Failed to create invite link' }, 500);
    }
  });

  // List active invite links
  app.get('/api/servers/:serverId/invite-links', async (c) => {
    try {
      const serverId = c.req.param('serverId');

      // Support server-token auth (header or query param — some proxies strip custom headers)
      const serverToken = c.req.header('X-Server-Token') || c.req.query('serverToken');
      if (serverToken) {
        const server = await ServerService.getServerByToken(serverToken);
        if (!server || server.id !== serverId) {
          return c.json({ error: 'Invalid server token' }, 401);
        }
        const inviteLinks = await ServerService.getInviteLinks(serverId);
        return c.json({ success: true, inviteLinks });
      }

      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const hasPermission = await ServerService.checkServerPermission(serverId, userId, ['owner']);
      if (!hasPermission) {
        return c.json({ error: 'Access denied' }, 403);
      }
      const inviteLinks = await ServerService.getInviteLinks(serverId);
      return c.json({ success: true, inviteLinks });
    } catch (error) {
      console.error('[HttpServer] Get invite links error:', error);
      return c.json({ error: 'Failed to get invite links' }, 500);
    }
  });

  // Revoke an invite link
  app.delete('/api/servers/:serverId/invite-links/:linkId', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const linkId = c.req.param('linkId');

      // Support server-token auth (header or query param — some proxies strip custom headers)
      const serverToken = c.req.header('X-Server-Token') || c.req.query('serverToken');
      if (serverToken) {
        const server = await ServerService.getServerByToken(serverToken);
        if (!server || server.id !== serverId) {
          return c.json({ error: 'Invalid server token' }, 401);
        }
        // Server has already verified permissions — use owner as requester to bypass cloud permission check
        const result = await ServerService.revokeInviteLink(serverId, server.ownerId, linkId);
        if (!result.success) {
          return c.json({ error: result.error }, 400);
        }
        return c.json({ success: true });
      }

      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const result = await ServerService.revokeInviteLink(serverId, userId, linkId);

      if (!result.success) {
        return c.json({ error: result.error }, 403);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Revoke invite link error:', error);
      return c.json({ error: 'Failed to revoke invite link' }, 500);
    }
  });

  // ==========================================================================
  // ==========================================================================
  // Public Ports (expose server services via custom subdomains)
  // ==========================================================================

  // List port mappings for a server
  app.get('/api/servers/:serverId/ports', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);
      const portMappings = await PublicPortService.listPortMappings(serverId);
      return c.json({ success: true, portMappings });
    } catch (error) {
      console.error('[HttpServer] List port mappings error:', error);
      return c.json({ error: 'Failed to list port mappings' }, 500);
    }
  });

  // Create a port mapping
  app.post('/api/servers/:serverId/ports', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const body = await c.req.json();
      const { subdomain, port, label } = body;

      if (!subdomain || typeof subdomain !== 'string') {
        return c.json({ error: 'Subdomain is required' }, 400);
      }
      if (!port || typeof port !== 'number') {
        return c.json({ error: 'Port is required and must be a number' }, 400);
      }

      const result = await PublicPortService.createPortMapping(serverId, userId, {
        subdomain: subdomain.toLowerCase(),
        port,
        label: label || undefined,
      });

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ success: true, portMapping: result.portMapping });
    } catch (error) {
      console.error('[HttpServer] Create port mapping error:', error);
      return c.json({ error: 'Failed to create port mapping' }, 500);
    }
  });

  // Delete a port mapping
  app.delete('/api/servers/:serverId/ports/:portId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const portId = c.req.param('portId');

      const result = await PublicPortService.deletePortMapping(serverId, userId, portId);

      if (!result.success) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Delete port mapping error:', error);
      return c.json({ error: 'Failed to delete port mapping' }, 500);
    }
  });

  // Check subdomain availability
  app.get('/api/public-ports/check-subdomain', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const subdomain = c.req.query('subdomain');
      if (!subdomain) {
        return c.json({ error: 'Subdomain query parameter is required' }, 400);
      }

      const result = await PublicPortService.checkSubdomainAvailability(subdomain.toLowerCase());
      return c.json(result);
    } catch (error) {
      console.error('[HttpServer] Check subdomain error:', error);
      return c.json({ error: 'Failed to check subdomain availability' }, 500);
    }
  });

  // Server Registration (for remote server servers)
  // ==========================================================================

  // Register a server with a server (called by server server on startup)
  app.post('/api/server/register', async (c) => {
    try {
      const body = await c.req.json();
      const { serverToken, serverUrl, machineId } = body;

      if (!serverToken || typeof serverToken !== 'string') {
        return c.json({ error: 'serverToken is required' }, 400);
      }
      if (!serverUrl || typeof serverUrl !== 'string') {
        return c.json({ error: 'serverUrl is required' }, 400);
      }

      const result = await ServerService.registerServer(serverToken, serverUrl, machineId);

      if (!result.success) {
        return c.json({ error: result.error }, 401);
      }

      return c.json({
        success: true,
        serverId: result.server?.id,
        serverName: result.server?.name,
      });
    } catch (error) {
      console.error('[HttpServer] Server register error:', error);
      return c.json({ error: 'Failed to register server' }, 500);
    }
  });

  // Server heartbeat (called periodically by server server to stay online)
  app.post('/api/server/heartbeat', async (c) => {
    try {
      const body = await c.req.json();
      const { serverToken, machineId, isIdle } = body;

      if (!serverToken || typeof serverToken !== 'string') {
        return c.json({ error: 'serverToken is required' }, 400);
      }

      const success = await ServerService.updateServerHeartbeat(
        serverToken,
        machineId,
        typeof isIdle === 'boolean' ? isIdle : undefined,
      );

      if (!success) {
        return c.json({ error: 'Invalid server token' }, 401);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Server heartbeat error:', error);
      return c.json({ error: 'Failed to update heartbeat' }, 500);
    }
  });

  // Sync the workspace's effective admin user-ID set to BE.
  // Authenticated with X-Server-Token; serverId in URL must match the token's server.
  // Called by the workspace's AdminMirrorPush on every role mutation and on boot.
  app.post('/api/internal/servers/:serverId/admins/sync', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const serverToken = c.req.header('X-Server-Token');
      if (!serverToken) {
        return c.json({ error: 'X-Server-Token required' }, 401);
      }
      const server = await ServerService.getServerByToken(serverToken);
      if (!server || server.id !== serverId) {
        return c.json({ error: 'Invalid server token' }, 401);
      }

      const body = await c.req.json().catch(() => null) as { admins?: unknown } | null;
      if (
        !body ||
        !Array.isArray(body.admins) ||
        !body.admins.every((v: unknown) => typeof v === 'string')
      ) {
        return c.json({ error: 'body.admins must be a string[]' }, 400);
      }

      const result = await ServerAdminMirrorService.syncAdmins(serverId, body.admins);
      return c.json(result);
    } catch (error) {
      console.error('[HttpServer] Admin mirror sync error:', error);
      return c.json({ error: 'Failed to sync admins' }, 500);
    }
  });

  // Sync workspace project metadata (currently: name) into widget_projects so
  // widget UIs reflect renames. Authenticated with X-Server-Token; serverId in
  // URL must match the token's server. Called by the workspace's
  // ProjectMirrorPush on every project mutation and on boot.
  app.post('/api/internal/servers/:serverId/projects/sync', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const serverToken = c.req.header('X-Server-Token');
      if (!serverToken) {
        return c.json({ error: 'X-Server-Token required' }, 401);
      }
      const server = await ServerService.getServerByToken(serverToken);
      if (!server || server.id !== serverId) {
        return c.json({ error: 'Invalid server token' }, 401);
      }

      const body = await c.req.json().catch(() => null) as { projects?: unknown } | null;
      if (
        !body ||
        !Array.isArray(body.projects) ||
        !body.projects.every((p: unknown): p is { id: string; name: string } =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as { id?: unknown }).id === 'string' &&
          typeof (p as { name?: unknown }).name === 'string',
        )
      ) {
        return c.json({ error: 'body.projects must be Array<{ id: string; name: string }>' }, 400);
      }

      const result = await WidgetService.syncProjectMetadata(serverId, body.projects);
      return c.json(result);
    } catch (error) {
      console.error('[HttpServer] Project mirror sync error:', error);
      return c.json({ error: 'Failed to sync projects' }, 500);
    }
  });

  /**
   * Workspace → BE mirror push for `agent_entities.widget_exposed`.
   * Called by WidgetAgentMirrorPush on every toggle and on boot.
   * Auth: X-Server-Token; serverId in URL must match the token's server.
   * Body: { projects: [{ workspaceProjectId, agents: [{ id, name, description }] }] }
   * Semantics: full-replace per workspaceProjectId.
   */
  app.post('/api/internal/servers/:serverId/widget-agents/sync', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const serverToken = c.req.header('X-Server-Token');
      if (!serverToken) return c.json({ error: 'X-Server-Token required' }, 401);
      const server = await ServerService.getServerByToken(serverToken);
      if (!server || server.id !== serverId) return c.json({ error: 'Invalid server token' }, 401);

      type Body = { projects?: Array<{ workspaceProjectId?: unknown; agents?: unknown }> };
      const body = await c.req.json().catch(() => null) as Body | null;
      if (
        !body ||
        !Array.isArray(body.projects) ||
        !body.projects.every(p =>
          typeof p?.workspaceProjectId === 'string' &&
          Array.isArray(p?.agents) &&
          (p.agents as unknown[]).every((a: any) =>
            typeof a?.id === 'string' &&
            typeof a?.name === 'string' &&
            (a?.description === null || a?.description === undefined || typeof a?.description === 'string')
          )
        )
      ) {
        return c.json({ error: 'Malformed body' }, 400);
      }

      const result = await WidgetService.syncWidgetExposedAgents(
        serverId,
        body.projects as WidgetService.SyncWidgetExposedAgentsInput[],
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      console.error('[HttpServer] widget-agents sync error:', err);
      return c.json({ error: 'sync failed' }, 500);
    }
  });

  /**
   * Workspace → BE turn-event callback for widget chat.
   * Auth: X-Server-Token (same as the widget-agents sync); body.serverId must
   * match the token's server, and WidgetChatService re-checks that the
   * conversation's project belongs to that server (cross-tenant guard).
   * Events upsert idempotently on (turn_id, seq) — retries are safe.
   */
  app.post('/api/internal/widget-chat/events', async (c) => {
    try {
      const serverToken = c.req.header('X-Server-Token');
      if (!serverToken) return c.json({ error: 'X-Server-Token required' }, 401);
      const server = await ServerService.getServerByToken(serverToken);
      if (!server) return c.json({ error: 'Invalid server token' }, 401);

      const body = await c.req.json().catch(() => null) as {
        serverId?: unknown; conversationId?: unknown; turnId?: unknown; events?: unknown;
      } | null;
      if (
        !body ||
        typeof body.serverId !== 'string' ||
        typeof body.conversationId !== 'string' ||
        typeof body.turnId !== 'string' ||
        !Array.isArray(body.events) ||
        body.events.length > 200
      ) {
        return c.json({ error: 'Malformed body' }, 400);
      }
      if (body.serverId !== server.id) return c.json({ error: 'serverId mismatch' }, 403);

      const result = await WidgetChatService.ingestTurnEvents(server.id, {
        conversationId: body.conversationId,
        turnId: body.turnId,
        events: body.events as WidgetChatService.TurnEventInput[],
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof WidgetService.WidgetError) return c.json({ error: err.code }, err.status as any);
      console.error('[HttpServer] widget-chat events error:', err);
      return c.json({ error: 'ingest failed' }, 500);
    }
  });

  // Get server info for a server (called by client)
  app.get('/api/servers/:serverId/server', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');

      // Check if user has access to this server
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }

      if (!server.serverUrl) {
        return c.json({ error: 'No server registered for this server' }, 404);
      }

      // Return in format expected by client
      return c.json({
        serverId: server.id,
        url: server.serverUrl,
        status: server.status || 'unknown',
        lastSeen: server.lastSeen,
      });
    } catch (error) {
      console.error('[HttpServer] Get server server error:', error);
      return c.json({ error: 'Failed to get server info' }, 500);
    }
  });

  // Wake a suspended remote server
  app.post('/api/servers/:serverId/server/wake', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);
      const result = await ServerService.wakeRemoteServer(serverId, userId);

      if (!result.success) {
        return c.json({ error: result.error }, result.error === 'Access denied' ? 403 : 400);
      }

      return c.json({
        success: true,
        status: result.status,
        url: result.url,
      });
    } catch (error) {
      console.error('[HttpServer] Wake server error:', error);
      return c.json({ error: 'Failed to wake server' }, 500);
    }
  });

  // Resolve a Fly machine ID to its server record (used by the preview gateway)
  app.get('/api/servers/by-machine/:machineId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const machineId = c.req.param('machineId');
      const server = await ServerService.getServerByMachineId(machineId);
      if (!server) {
        return c.json({ error: 'Not found' }, 404);
      }

      const gate = await ServerService.gateServerAccess(server.id, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      return c.json({ serverId: server.id, serverUrl: server.serverUrl, status: server.status });
    } catch (error) {
      console.error('[HttpServer] Get server by machine error:', error);
      return c.json({ error: 'Failed to get server by machine' }, 500);
    }
  });

  // Probe whether a specific preview port on a Fly machine is ready
  app.get('/api/servers/:serverId/preview/health', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const portParam = c.req.query('port');
      const port = portParam !== undefined ? Number(portParam) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return c.json({ error: 'Invalid port' }, 400);
      }

      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }
      if (!server.serverUrl) {
        return c.json({ error: 'Server has no URL' }, 404);
      }

      const ready = await PreviewCoordinator.probeReady({ server, userId, port });
      return c.json({ ready });
    } catch (error) {
      console.error('[HttpServer] Preview health error:', error);
      return c.json({ error: 'Failed to probe preview health' }, 500);
    }
  });

  // Mint a short-lived server-scoped JWT for the preview-gateway handoff
  app.post('/api/servers/:serverId/preview/mint-token', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const body = await c.req.json().catch(() => ({}));
      const ttlSeconds = typeof body.ttlSeconds === 'number' ? body.ttlSeconds : 86400;
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        return c.json({ error: 'Invalid ttlSeconds' }, 400);
      }

      const minted = await ServerSessionService.generateServerSessionToken(userId, serverId, ttlSeconds);
      const parts = minted.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      console.log('[HttpServer] Minted preview token for', userId, serverId);
      return c.json({ token: minted, expiresAt: payload.exp * 1000 });
    } catch (error) {
      console.error('[HttpServer] Mint token error:', error);
      return c.json({ error: 'Failed to mint token' }, 500);
    }
  });

  // Resolve a preview port to its owning channel + startingCommand
  app.get('/api/servers/:serverId/preview/channel-for-port', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const portParam = c.req.query('port');
      const port = portParam !== undefined ? Number(portParam) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return c.json({ error: 'Invalid port' }, 400);
      }

      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }
      if (!server.serverUrl) {
        return c.json({ error: 'Server has no URL' }, 404);
      }

      const match = await PreviewCoordinator.channelForPort({ server, userId, port });
      if (!match) {
        return c.json({ error: 'No channel on this port' }, 404);
      }

      return c.json(match);
    } catch (error) {
      console.error('[HttpServer] Channel-for-port error:', error);
      return c.json({ error: 'Failed to resolve channel for port' }, 500);
    }
  });

  // Start (or reuse) a channel's startingCommand on the Fly machine
  app.post('/api/servers/:serverId/preview/start-channel', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const body = await c.req.json().catch(() => ({}));
      const { channelId, force } = body as { channelId?: unknown; force?: unknown };
      if (!channelId || typeof channelId !== 'string') {
        return c.json({ error: 'channelId required' }, 400);
      }

      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }
      if (!server.serverUrl) {
        return c.json({ error: 'Server has no URL' }, 404);
      }

      const result = await PreviewCoordinator.startChannel({
        server,
        userId,
        channelId,
        force: force === true,
      });
      return c.json(result);
    } catch (error) {
      console.error('[HttpServer] Start-channel error:', error);
      return c.json({ error: 'Failed to start channel' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Preview widget auto-injection
  //
  // Both endpoints are called by the Fly preview proxy (not the dashboard), so
  // they authenticate via a server-session JWT (`preview_token`) rather than a
  // user session token. The JWT's serverId claim must match the URL serverId.
  // ---------------------------------------------------------------------------

  // Return widget bootstrap (token + config) for the authenticated preview user.
  // 404 when widget is not enabled, auto-inject is off, or no channel is set.
  app.post('/api/servers/:serverId/preview/widget-bootstrap', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);

      const payload = await ServerSessionService.verifyServerSessionToken(token);
      if (!payload) return c.json({ error: 'Invalid server-session token' }, 401);

      const urlServerId = c.req.param('serverId');
      if (payload.serverId !== urlServerId) {
        return c.json({ error: 'Server mismatch' }, 403);
      }

      const body = await c.req.json().catch(() => ({}));
      const projectId: string | undefined = body?.projectId;
      if (!projectId) return c.json({ error: 'No widget for this preview' }, 404);

      // Do NOT trust `payload.userName` — preview tokens are mintable by any
      // server member with their own claimed name. Resolve the canonical name
      // from the DB by userId so widget tickets/comments cannot be authored
      // under a spoofed display name.
      const [user] = await db
        .select({ name: users.name, username: users.username })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);
      const canonicalName = user?.name ?? user?.username ?? undefined;

      const bootstrap = await WidgetService.generatePreviewWidgetBootstrap(
        payload.serverId,
        payload.userId,
        canonicalName,
        projectId,
      );
      if (!bootstrap) return c.json({ error: 'Widget auto-inject not enabled' }, 404);

      return c.json(bootstrap);
    } catch (error) {
      console.error('[HttpServer] Preview widget-bootstrap error:', error);
      return c.json({ error: 'Failed to build widget bootstrap' }, 500);
    }
  });

  // Return whether the preview proxy should inject the bootstrap script for
  // this server. Cached indefinitely by the proxy; invalidated via push from
  // the widget-settings update handler below.
  app.get('/api/servers/:serverId/preview/widget-config', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);

      const payload = await ServerSessionService.verifyServerSessionToken(token);
      if (!payload) return c.json({ error: 'Invalid server-session token' }, 401);

      const urlServerId = c.req.param('serverId');
      if (payload.serverId !== urlServerId) {
        return c.json({ error: 'Server mismatch' }, 403);
      }

      const projectId = c.req.query('projectId');
      if (!projectId) return c.json({ shouldInject: false });

      const flag = await WidgetService.getPreviewWidgetFlag(payload.serverId, projectId);
      return c.json(flag);
    } catch (error) {
      console.error('[HttpServer] Preview widget-config error:', error);
      return c.json({ error: 'Failed to read widget config' }, 500);
    }
  });

  // Report a workspace as unreachable from the client. This is a SIGNAL,
  // not a restart command — BE decides the appropriate action (no_op, wake,
  // restart, flapping, missing) based on objective state (provider machine
  // state + machine-targeted /health probe). Non-admin members cannot
  // directly force a restart via this endpoint.
  app.post('/api/servers/:serverId/report-unreachable', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ action: 'unauthenticated' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ action: 'unauthenticated' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await AutoHealService.reportUnreachable({ serverId, userId });
      return c.json(result.body, result.status as any);
    } catch (error) {
      console.error('[HttpServer] report-unreachable error:', error);
      return c.json({ action: 'provider_unavailable' }, 503);
    }
  });

  // Poll terminal state of a heal attempt. Client uses this to exit its
  // `healing` state deterministically (instead of a blind watchdog timeout).
  app.get('/api/servers/:serverId/heal-attempts/:attemptId', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'unauthenticated' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'unauthenticated' }, 401);
      }

      const serverId = c.req.param('serverId');
      const attemptId = c.req.param('attemptId');
      const result = await AutoHealService.getHealAttemptStatus(serverId, userId, attemptId);
      return c.json(result.body, result.status as any);
    } catch (error) {
      console.error('[HttpServer] heal-attempts status error:', error);
      return c.json({ error: 'internal_error' }, 500);
    }
  });

  // Restart a remote server
  app.post('/api/servers/:serverId/server/restart', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await ServerService.restartRemoteServer(serverId, userId);

      if (!result.success) {
        return c.json({ error: result.error }, result.error === 'Access denied' ? 403 : 400);
      }

      return c.json({
        success: true,
        status: result.status,
        url: result.url,
      });
    } catch (error) {
      console.error('[HttpServer] Restart server error:', error);
      return c.json({ error: 'Failed to restart server' }, 500);
    }
  });

  // Update a remote server's image to latest (owner-only)
  app.post('/api/servers/:serverId/server/update', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await ServerService.updateRemoteServer(serverId, userId);

      if (!result.success) {
        const status = result.error === 'Only the server owner can update the server image' ? 403
          : result.error === 'Access denied' ? 403 : 400;
        return c.json({ error: result.error }, status);
      }

      return c.json({
        success: true,
        status: result.status,
        url: result.url,
      });
    } catch (error) {
      console.error('[HttpServer] Update server error:', error);
      return c.json({ error: 'Failed to update server' }, 500);
    }
  });

  // Get remote server status
  app.get('/api/servers/:serverId/server/status', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);
      const result = await ServerService.getRemoteServerStatus(serverId, userId);

      if (!result) {
        return c.json({ error: 'Not found or not a remote server' }, 404);
      }

      return c.json(result);
    } catch (error) {
      console.error('[HttpServer] Get server status error:', error);
      return c.json({ error: 'Failed to get status' }, 500);
    }
  });

  // Regenerate server token (owner only) - returns new plaintext token
  app.post('/api/servers/:serverId/regenerate-token', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const result = await ServerService.regenerateServerToken(serverId, userId);

      if (!result.success) {
        return c.json({ error: result.error }, 403);
      }

      return c.json({
        success: true,
        serverToken: result.serverToken, // Plaintext token - user copies this
      });
    } catch (error) {
      console.error('[HttpServer] Regenerate server token error:', error);
      return c.json({ error: 'Failed to regenerate token' }, 500);
    }
  });

  // ==========================================================================
  // Server Session Tokens (for secure client-server communication)
  // ==========================================================================

  // Generate a server-scoped session token for connecting to a server
  // Client calls this before connecting to server server
  // For remote servers, this also ensures the machine is awake and ready
  app.post('/api/servers/:serverId/session', async (c) => {
    try {
      c.header('Cache-Control', 'no-store');
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const token = authHeader.substring(7);
      const userId = await extractUserIdFromToken(token);
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');

      // Verify user has access to this server
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      // Fetch user info + server role for JWT (name/email for presence + chat display, role for permissions)
      const [sessionUser] = await db.select({ username: users.username, name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
      const serverRole = await ServerService.getMemberRole(serverId, userId);
      console.log(`[HttpServer] Session for server ${serverId}, user ${userId}: serverRole=${serverRole}`);
      const sessionTokenOpts = {
        userName: sessionUser?.username || sessionUser?.name || undefined,
        userEmail: sessionUser?.email ?? undefined,
        serverRole: serverRole ?? undefined,
      };

      // Get server to check if it's a remote server
      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }

      const tokenExpirySeconds = server.sessionTokenExpirySeconds ?? 86400; // default 24h

      // Fast-path: if server is remote, online, has a machine, and heartbeat is recent,
      // skip the entire wake + identity verification flow. This saves ~1-3s per switch.
      const FAST_PATH_HEARTBEAT_THRESHOLD_MS = 30_000;
      if (
        server.deploymentType === 'remote' &&
        server.status === 'online' &&
        server.machineId &&
        server.lastSeen &&
        (Date.now() - server.lastSeen.getTime()) < FAST_PATH_HEARTBEAT_THRESHOLD_MS
      ) {
        console.log(`[HttpServer] Fast-path session for server ${serverId} (lastSeen ${Math.round((Date.now() - server.lastSeen.getTime()) / 1000)}s ago)`);
        const provider = getProvider((server.provider || 'fly') as ProviderId);
        const routing = provider.getRoutingInfo(server.machineId, server.flyAppName);
        const [serverSessionToken, latestServerVersion] = await Promise.all([
          ServerSessionService.generateServerSessionToken(userId, serverId, tokenExpirySeconds, sessionTokenOpts),
          getLatestServerVersion(),
        ]);
        return c.json({
          success: true,
          serverSessionToken,
          // Only advertise machineId to the client when the provider's routing
          // actually needs it (Fly uses it as `fly_instance_id`). For
          // DockerProvider the host port already disambiguates and exposing
          // the container id makes the runhq client append `fly_instance_id`,
          // which the host machine's WS upgrade router would then reject as
          // misdirected.
          machineId: routing.requiresRoutingHeaders ? server.machineId : null,
          serverUrl: routing.serverUrl || server.serverUrl,
          expiresIn: tokenExpirySeconds,
          serverName: server.name,
          serverStatus: server.status,
          deploymentType: server.deploymentType,
          latestServerVersion,
        });
      }

      // For remote servers, ensure the machine is awake and server is ready
      let needsRefetch = false;
      if (server.deploymentType === 'remote' && isAnyProviderConfigured()) {
        // If server is still provisioning (e.g. during region change), don't try to connect yet.
        // migrationInProgress covers per-tenant migration where heartbeat /
        // register can clobber status='provisioning' to 'online' mid-flow.
        if (server.status === 'provisioning' || server.migrationInProgress) {
          return c.json({ error: 'Server is still provisioning. Please try again shortly.', serverName: server.name }, 503);
        }

        // Check if provisioning/reprovisioning is needed and gate behind payment
        const needsProvision = !server.machineId;

        if (needsProvision) {
          // Gate provisioning behind payment method check
          const subscription = await UsageService.getOrCreateSubscription(userId);
          if (!subscription.stripeCustomerId) {
            console.log(`[HttpServer] No payment method for user ${userId}, blocking reprovision of server ${serverId}`);
            return c.json({ error: 'Payment method required before provisioning', needsPayment: true }, 402);
          }
        }

        // If no machine exists, kick off reprovisioning in background and return immediately
        if (needsProvision) {
          console.log(`[HttpServer] No machine for server ${serverId}, starting background reprovision...`);
          await ServerService.setServerStatus(serverId, 'provisioning');
          ServerService.reprovisionRemoteServer(serverId, userId).catch(err => {
            console.error(`[HttpServer] Background reprovision failed for ${serverId}:`, err);
          });
          return c.json({ error: 'Server is provisioning. Please try again shortly.', serverName: server.name }, 503);
        } else {
          // Machine exists, wake it if needed (using internal version to skip redundant access/fetch)
          console.log(`[HttpServer] Waking machine for server ${serverId} before session...`);
          const wakeResult = await ServerService.wakeRemoteServerInternal(server);
          if (!wakeResult.success) {
            // Never auto-reprovision based on a wake error string. String
            // matching on "destroyed" / "not found" is how transient Fly API
            // errors used to cascade into destructive reprovisions that wiped
            // the DB reference to live running machines. The error is surfaced
            // as-is; if the machine really is gone, `/admin/servers` will
            // classify the row as 'stale' and an admin can trigger an explicit
            // reprovision deliberately.
            console.error(`[HttpServer] Failed to wake machine for server ${serverId}: ${wakeResult.error}`);
            return c.json({ error: wakeResult.error || 'Failed to wake server', serverName: server.name }, 503);
          } else {
            if (wakeResult.wasAlreadyRunning) {
              console.log(`[HttpServer] Machine was already running, skipping wait`);
            } else {
              console.log(`[HttpServer] Machine woken and healthy`);
              needsRefetch = true;
            }
          }
        }
        console.log(`[HttpServer] Server should be ready for server ${serverId}`);
      }

      // Only re-fetch if wake/reprovision changed the server state.
      // This avoids a redundant DB query when the machine was already running.
      const latestServer = needsRefetch
        ? await ServerService.getServer(serverId)
        : server;
      if (!latestServer) {
        return c.json({ error: 'Server not found' }, 404);
      }

      let serverUrl = latestServer.serverUrl;
      if (latestServer.machineId) {
        const provider = getProvider((latestServer.provider || 'fly') as ProviderId);
        const routingUrl = provider.getRoutingInfo(latestServer.machineId, latestServer.flyAppName).serverUrl;
        if (routingUrl) serverUrl = routingUrl;
      }

      if (latestServer.deploymentType === 'remote' && !latestServer.machineId && isAnyProviderConfigured()) {
        return c.json({ error: 'Server machine is not ready yet. Please try again shortly.', serverName: latestServer.name }, 503);
      }

      if (!serverUrl) {
        return c.json({ error: 'Server server URL is not available yet. Please try again shortly.', serverName: latestServer.name }, 503);
      }

      let routingMachineId = latestServer.machineId || null;
      // Whether this provider needs the machineId surfaced to the client for
      // routing (Fly → yes, Docker → no). Captured here so the response below
      // can drop machineId when the provider doesn't need it; without that,
      // the runhq client appends `fly_instance_id=<value>` to every WS upgrade
      // and the host runhq's upgrade router rejects mismatched ids with 421.
      let providerNeedsRoutingId = false;

      // Verify machine identity to detect stale routing.
      // If mismatch, return error — the correct fix is reprovisioning, not scanning all machines.
      let machineUnresponsive = false;
      if (latestServer.deploymentType === 'remote' && routingMachineId) {
        try {
          const provider = getProvider((latestServer.provider || 'fly') as ProviderId);
          const routing = provider.getRoutingInfo(routingMachineId, latestServer.flyAppName);
          providerNeedsRoutingId = routing.requiresRoutingHeaders;
          const routingHeaders: Record<string, string> = { 'cache-control': 'no-cache' };
          // Only add provider-specific routing headers when required (e.g. Fly's fly-force-instance-id)
          if (routing.requiresRoutingHeaders && routing.routingToken) {
            routingHeaders['fly-force-instance-id'] = routing.routingToken;
          }
          const infoParams = routing.requiresRoutingHeaders && routing.routingToken
            ? `?fly_instance_id=${encodeURIComponent(routing.routingToken)}`
            : '';
          const infoUrl = `${serverUrl}/info${infoParams}`;
          const infoAbort = new AbortController();
          const infoTimeout = setTimeout(() => infoAbort.abort(), 5000);
          const infoRes = await fetch(infoUrl, {
            method: 'GET',
            headers: routingHeaders,
            signal: infoAbort.signal,
          });
          clearTimeout(infoTimeout);

          if (infoRes.ok) {
            const info = await infoRes.json().catch(() => ({})) as { serverId?: string };
            if (info.serverId && info.serverId !== serverId) {
              console.error(`[HttpServer] Routing mismatch for server ${serverId}: machine ${routingMachineId} belongs to ${info.serverId}`);
              // Clear stale machine ref so reprovisioning kicks in on next attempt
              await db
                .update(servers)
                .set({ machineId: null, machineName: null, serverUrl: null, status: 'offline', updatedAt: new Date() })
                .where(eq(servers.id, serverId));
              return c.json({ error: 'Server routing mismatch detected. Reprovisioning will happen on next connect.' }, 503);
            }
          } else {
            console.warn(`[HttpServer] Machine /info check returned ${infoRes.status} for server ${serverId}`);
            machineUnresponsive = true;
          }
        } catch {
          console.warn(`[HttpServer] Machine unreachable during /info check for server ${serverId}`);
          machineUnresponsive = true;
        }
      }

      // Generate a server-scoped session token with configured expiry
      const latestTokenExpiry = latestServer.sessionTokenExpirySeconds ?? tokenExpirySeconds;
      const [serverSessionToken, latestServerVersion] = await Promise.all([
        ServerSessionService.generateServerSessionToken(userId, serverId, latestTokenExpiry, sessionTokenOpts),
        getLatestServerVersion(),
      ]);

      return c.json({
        success: true,
        serverSessionToken,
        // See `providerNeedsRoutingId` above — drop machineId for providers
        // (DockerProvider) that don't need fly_instance_id-style routing.
        machineId: providerNeedsRoutingId ? routingMachineId : null,
        serverUrl,
        expiresIn: latestTokenExpiry,
        serverName: latestServer.name,
        serverStatus: latestServer.status,
        deploymentType: latestServer.deploymentType,
        latestServerVersion,
        ...(machineUnresponsive ? { machineUnresponsive: true } : {}),
      });
    } catch (error) {
      console.error('[HttpServer] Generate server session error:', error);
      return c.json({ error: 'Failed to generate session token' }, 500);
    }
  });

  // Verify a server session token (called by server server to validate client connection)
  app.post('/api/server/verify-session', async (c) => {
    try {
      const body = await c.req.json();
      const { serverSessionToken } = body;

      if (!serverSessionToken || typeof serverSessionToken !== 'string') {
        return c.json({ error: 'serverSessionToken is required' }, 400);
      }

      const payload = await ServerSessionService.verifyServerSessionToken(serverSessionToken);

      if (!payload) {
        return c.json({ valid: false, error: 'Invalid or expired token' }, 401);
      }

      // Look up user info for the server server to use
      const [user] = await db.select({ username: users.username, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);

      return c.json({
        valid: true,
        userId: payload.userId,
        userName: user?.username || user?.name || user?.email || 'User',
        userEmail: user?.email,
        serverId: payload.serverId,
        serverRole: payload.serverRole,
        scope: payload.scope,
        expiresAt: payload.exp,
      });
    } catch (error) {
      console.error('[HttpServer] Verify server session error:', error);
      return c.json({ error: 'Failed to verify session token' }, 500);
    }
  });

  // Update session token expiry settings (proxied from server, authenticated by server token)
  // Get session token expiry settings
  app.get('/api/servers/:serverId/session-settings', async (c) => {
    try {
      const serverId = c.req.param('serverId');
      const serverToken = c.req.header('X-Server-Token');
      if (!serverToken) {
        return c.json({ error: 'X-Server-Token required' }, 401);
      }
      const server = await ServerService.getServerByToken(serverToken);
      if (!server || server.id !== serverId) {
        return c.json({ error: 'Invalid server token' }, 401);
      }
      return c.json({ sessionTokenExpirySeconds: server.sessionTokenExpirySeconds ?? 86400 });
    } catch (error) {
      console.error('[HttpServer] Get session settings error:', error);
      return c.json({ error: 'Failed to get session settings' }, 500);
    }
  });

  app.patch('/api/servers/:serverId/session-settings', async (c) => {
    try {
      const serverId = c.req.param('serverId');

      // Authenticate via server token (server proxies this request)
      const serverToken = c.req.header('X-Server-Token');
      if (!serverToken) {
        return c.json({ error: 'X-Server-Token required' }, 401);
      }
      const server = await ServerService.getServerByToken(serverToken);
      if (!server || server.id !== serverId) {
        return c.json({ error: 'Invalid server token' }, 401);
      }

      const body = await c.req.json() as { sessionTokenExpirySeconds?: number };
      if (body.sessionTokenExpirySeconds === undefined || body.sessionTokenExpirySeconds === null) {
        return c.json({ error: 'sessionTokenExpirySeconds is required' }, 400);
      }

      const expirySeconds = await ServerService.updateSessionTokenExpiry(serverId, body.sessionTokenExpirySeconds);
      return c.json({ success: true, sessionTokenExpirySeconds: expirySeconds });
    } catch (error) {
      if (error instanceof Error && error.message.includes('must be an integer between')) {
        return c.json({ error: error.message }, 400);
      }
      console.error('[HttpServer] Update session settings error:', error);
      return c.json({ error: 'Failed to update session settings' }, 500);
    }
  });

  // ==========================================================================
  // Server-wide MFA enforcement policy
  // ==========================================================================

  // Read MFA enforcement status for a server. Any member may read aggregate
  // counts; only the owner receives the list of members without MFA.
  app.get('/api/servers/:serverId/mfa-status', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const userId = await extractUserIdFromToken(authHeader.substring(7));
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const gate = await ServerService.gateServerAccess(serverId, userId);
      if (!gate.ok) return c.json(gate.body, gate.status);

      const status = await ServerService.getServerMfaStatus(serverId, userId);
      if (!status) return c.json({ error: 'Server not found' }, 404);
      return c.json(status);
    } catch (error) {
      console.error('[HttpServer] Get server MFA status error:', error);
      return c.json({ error: 'Failed to get MFA status' }, 500);
    }
  });

  // Toggle the per-server MFA enforcement policy. Allowed for cloud-level
  // owner OR per-server RBAC administrator — see canManageServerSecurity.
  app.patch('/api/servers/:serverId/security', async (c) => {
    try {
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const userId = await extractUserIdFromToken(authHeader.substring(7));
      if (!userId) {
        return c.json({ error: 'Invalid token' }, 401);
      }

      const serverId = c.req.param('serverId');
      const editGate = await ServerService.gateServerEdit(serverId, userId);
      if (!editGate.ok) return c.json(editGate.body, editGate.status);

      const canManage = await ServerService.canManageServerSecurity(serverId, userId);
      if (!canManage) {
        return c.json({ error: 'Administrator role required' }, 403);
      }

      let body: { requireMfa?: unknown };
      try { body = await c.req.json(); }
      catch { return c.json({ error: 'Invalid JSON' }, 400); }

      if (typeof body.requireMfa !== 'boolean') {
        return c.json({ error: 'requireMfa: boolean required' }, 400);
      }

      const applied = await ServerService.setServerRequireMfa(serverId, body.requireMfa);
      if (!applied) return c.json({ error: 'Server not found' }, 404);
      return c.json(applied);
    } catch (error) {
      console.error('[HttpServer] Update server security policy error:', error);
      return c.json({ error: 'Failed to update security policy' }, 500);
    }
  });

  // ==========================================================================
  // Canonical Workspace/Public Tasks
  // ==========================================================================

  const taskAttachmentStorage = new TaskAttachmentStorageService();

  async function requireAuthenticatedUser(c: any): Promise<string | null> {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;
    return extractUserIdFromToken(authHeader.substring(7));
  }

  app.get('/api/servers/:serverId/workspace-tasks', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerAccess(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const visibility = c.req.query('visibility');
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const workspaceProjectId = c.req.query('workspaceProjectId') ?? undefined;
    const workspaceChannelId = c.req.query('workspaceChannelId') ?? undefined;
    const includeAttachments = c.req.query('includeAttachments') === 'true';
    const tasks = await WorkspaceTaskService.listTasksByServer(serverId, {
      visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined,
      includeDeleted,
      workspaceProjectId,
      workspaceChannelId,
      includeAttachments,
      viewerId: userId,
      viewerType: 'member',
    });
    return c.json({ success: true, data: tasks });
  });

  // Fields a server member is allowed to set on task create. Identity-bearing
  // fields (createdBy*), moderation-bearing fields, and migration-internal
  // fields are intentionally excluded — they are server-controlled.
  // Fields a server member is allowed to set on task create. Identity-bearing
  // fields, moderation/source/upvote/legacy fields, and attachments are
  // intentionally excluded.
  //
  // Why no attachments here: client-supplied storageProvider/storageKey are
  // persisted verbatim (see WorkspaceTaskService.createTask). Without an
  // ownership check, a member could attach another user's R2/S3 object as
  // theirs, then later trigger storage deletion via a deleteComment-style
  // path. Legitimate attachment uploads go through the server-token
  // /api/server/workspace-task-attachments/upload endpoint, which is the
  // trust boundary that owns storage references.
  const TASK_CREATE_MEMBER_FIELDS = [
    'workspaceProjectId',
    'workspaceChannelId',
    'title',
    'description',
    'status',
    'visibility',
    'type',
    'schedule',
    'scheduledAt',
    'timezone',
    'commentsDisabled',
  ] as const;

  // Fields a server member is allowed to update on a task. archivedAt and
  // deletedAt are excluded (ownership-sensitive). Attachments are excluded
  // for the same reason as on create — see TASK_CREATE_MEMBER_FIELDS.
  const TASK_UPDATE_MEMBER_FIELDS = [
    'workspaceProjectId',
    'workspaceChannelId',
    'title',
    'description',
    'status',
    'visibility',
    // 'isPublished' intentionally EXCLUDED: admin-only. It must flow only via the
    // trusted server-token route (/api/server/workspace-tasks/:taskId, no allowlist)
    // where the runhq server enforces the admin (manage_todos) gate upstream in
    // PATCH /todos/:id. The user-bearer /api/servers/:serverId/... route is only
    // edit-gated, so allowing isPublished here would let a non-admin editor publish
    // tasks + force visibility public, bypassing the gate.
    'type',
    'schedule',
    'scheduledAt',
    'timezone',
    'completedAt',
    'commentsDisabled',
  ] as const;

  function pickFields<T extends string>(body: unknown, allowed: readonly T[]): Record<T, unknown> {
    const out = {} as Record<T, unknown>;
    if (!body || typeof body !== 'object') return out;
    for (const key of allowed) {
      if (key in (body as Record<string, unknown>)) {
        out[key] = (body as Record<string, unknown>)[key];
      }
    }
    return out;
  }

  async function resolveMemberIdentity(userId: string): Promise<{
    createdByType: 'member';
    createdById: string;
    createdByName: string | null;
  }> {
    const [user] = await db
      .select({ name: users.name, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return {
      createdByType: 'member',
      createdById: userId,
      createdByName: user?.name ?? user?.username ?? null,
    };
  }

  app.post('/api/servers/:serverId/workspace-tasks', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerEdit(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const body = await c.req.json();
    if (typeof (body as { title?: unknown })?.title !== 'string' || !(body as { title: string }).title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }

    const safe = pickFields(body, TASK_CREATE_MEMBER_FIELDS);
    const identity = await resolveMemberIdentity(userId);
    const task = await WorkspaceTaskService.createTask(serverId, {
      ...safe,
      ...identity,
      sourceType: 'workspace',
    } as Parameters<typeof WorkspaceTaskService.createTask>[1]);
    return c.json({ success: true, data: task }, 201);
  });

  app.patch('/api/servers/:serverId/workspace-tasks/:taskId', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerEdit(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const body = await c.req.json();
    const MEMBER_FIELDS_WITH_INTERACTOR = [...TASK_UPDATE_MEMBER_FIELDS, 'lastInteractorUserId'] as const;
    const safe = pickFields(body, MEMBER_FIELDS_WITH_INTERACTOR);
    const { task, notification } = await WorkspaceTaskService.updateTask(
      serverId,
      c.req.param('taskId'),
      safe as Parameters<typeof WorkspaceTaskService.updateTask>[2],
      { type: 'user', userId },
    );
    if (!task) return c.json({ error: 'Task not found' }, 404);
    // `notification` (when present) is shipped to the calling per-server so it
    // can push to its connected WS clients — sub-second in-app delivery
    // without a separate browser-to-BE WebSocket connection.
    return c.json({ success: true, data: task, notification });
  });

  app.post('/api/servers/:serverId/workspace-tasks/:taskId/upvote', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerAccess(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.setTaskUpvote(serverId, c.req.param('taskId'), {
      voterId: userId,
      voterType: 'member',
      value: true,
    });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, data: task });
  });

  app.delete('/api/servers/:serverId/workspace-tasks/:taskId/upvote', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerAccess(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.setTaskUpvote(serverId, c.req.param('taskId'), {
      voterId: userId,
      voterType: 'member',
      value: false,
    });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, data: task });
  });

  app.get('/api/servers/:serverId/workspace-tasks/:taskId/comments', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerAccess(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.getTaskById(serverId, c.req.param('taskId'), {
      includeAttachments: true,
      viewerId: userId,
      viewerType: 'member',
    });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const comments = await WorkspaceTaskService.listComments(task.id);
    return c.json({ success: true, data: comments });
  });

  app.post('/api/servers/:serverId/workspace-tasks/:taskId/comments', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerEdit(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.getTaskById(serverId, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const body = await c.req.json();
    const content = (body as { content?: unknown })?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return c.json({ error: 'content is required' }, 400);
    }
    // Attachments are not accepted from the user-token path — see comment on
    // TASK_CREATE_MEMBER_FIELDS for the storage-ownership rationale.
    const identity = await resolveMemberIdentity(userId);
    const comment = await WorkspaceTaskService.addComment(serverId, task.id, {
      content,
      ...identity,
    });
    return c.json({ success: true, data: comment }, 201);
  });

  app.delete('/api/servers/:serverId/workspace-tasks/:taskId/comments/:commentId', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerEdit(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.getTaskById(serverId, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const result = await WorkspaceTaskService.deleteComment(serverId, task.id, c.req.param('commentId'), {
      actorId: userId,
      actorType: 'member',
    });
    if (result === 'not_found') return c.json({ error: 'Comment not found' }, 404);
    if (result === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
    return c.json({ success: true });
  });

  app.get('/api/servers/:serverId/workspace-tasks/:taskId/activity', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerAccess(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.getTaskById(serverId, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const activity = await WorkspaceTaskService.listActivity(task.id);
    return c.json({ success: true, data: activity });
  });

  app.post('/api/servers/:serverId/workspace-tasks/:taskId/activity', async (c) => {
    const userId = await requireAuthenticatedUser(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const serverId = c.req.param('serverId');
    const gate = await ServerService.gateServerEdit(serverId, userId);
    if (!gate.ok) return c.json(gate.body, gate.status);

    const task = await WorkspaceTaskService.getTaskById(serverId, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const body = await c.req.json();
    const activityType = (body as { type?: unknown })?.type;
    if (typeof activityType !== 'string' || !activityType) {
      return c.json({ error: 'type is required' }, 400);
    }
    const identity = await resolveMemberIdentity(userId);
    // Attachments are not accepted from the user-token path — see comment on
    // TASK_CREATE_MEMBER_FIELDS for the storage-ownership rationale.
    const activity = await WorkspaceTaskService.addActivity(serverId, task.id, {
      type: activityType as Parameters<typeof WorkspaceTaskService.addActivity>[2]['type'],
      content: typeof (body as { content?: unknown })?.content === 'string' ? (body as { content: string }).content : null,
      metadata: ((body as { metadata?: unknown })?.metadata as Record<string, unknown> | null) ?? null,
      ...identity,
    });
    return c.json({ success: true, data: activity }, 201);
  });

  app.post('/api/server/workspace-tasks', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json();
    const task = await WorkspaceTaskService.createTask(server.id, body);
    return c.json({ success: true, data: task }, 201);
  });

  app.post('/api/server/workspace-task-attachments/upload', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);
    if (!taskAttachmentStorage.isConfigured()) {
      return c.json({ error: 'Task attachment object storage is not configured' }, 503);
    }

    const formData = await c.req.raw.formData();
    const file = formData.get('file');
    if (!file || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ error: 'file field is required' }, 400);
    }

    const inputFile = file as globalThis.File;
    const filename = String(formData.get('filename') || inputFile.name || 'attachment.bin');
    const mimeType = String(formData.get('mimeType') || inputFile.type || 'application/octet-stream');
    const originalNameValue = formData.get('originalName');
    const modeValue = formData.get('mode');
    const ownerTypeValue = formData.get('ownerType');
    const ownerLegacyIdValue = formData.get('ownerLegacyId');
    const promoteAttachmentIdValue = formData.get('promoteAttachmentId');

    const storedAttachment = await taskAttachmentStorage.storeUpload({
      serverId: server.id,
      body: Buffer.from(await inputFile.arrayBuffer()),
      filename,
      mimeType,
      originalName: typeof originalNameValue === 'string' ? originalNameValue : inputFile.name,
      mode: modeValue === 'migration' ? 'migration' : 'upload',
      ownerType: ownerTypeValue === 'task' || ownerTypeValue === 'comment' || ownerTypeValue === 'activity'
        ? ownerTypeValue
        : undefined,
      ownerLegacyId: typeof ownerLegacyIdValue === 'string' ? ownerLegacyIdValue : null,
    });

    if (typeof promoteAttachmentIdValue === 'string' && promoteAttachmentIdValue) {
      const updatedAttachment = await WorkspaceTaskService.updateAttachmentStorage(server.id, promoteAttachmentIdValue, {
        storageProvider: storedAttachment.storageProvider,
        storageKey: storedAttachment.storageKey,
        mimeType: storedAttachment.mimeType,
        originalName: storedAttachment.originalName ?? null,
      });
      if (!updatedAttachment) {
        return c.json({ error: 'Canonical attachment not found' }, 404);
      }
    }

    return c.json({ success: true, data: storedAttachment }, 201);
  });

  app.post('/api/server/workspace-task-attachments/:attachmentId/demote', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json();
    if (!body?.filename || typeof body.filename !== 'string') {
      return c.json({ error: 'filename is required' }, 400);
    }

    const attachment = await WorkspaceTaskService.demoteAttachmentToWorkspaceLocal(server.id, c.req.param('attachmentId'), {
      filename: body.filename,
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream',
      originalName: typeof body.originalName === 'string' ? body.originalName : null,
    });
    if (!attachment) {
      return c.json({ error: 'Canonical attachment not found' }, 404);
    }

    return c.json({ success: true, data: attachment });
  });

  app.get('/api/server/workspace-tasks', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const visibility = c.req.query('visibility');
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const workspaceProjectId = c.req.query('workspaceProjectId') ?? undefined;
    const workspaceChannelId = c.req.query('workspaceChannelId') ?? undefined;
    const includeAttachments = c.req.query('includeAttachments') === 'true';
    const tasks = await WorkspaceTaskService.listTasksByServer(server.id, {
      visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined,
      includeDeleted,
      workspaceProjectId,
      workspaceChannelId,
      includeAttachments,
      viewerId: c.req.query('viewerId') ?? undefined,
      viewerType: c.req.query('viewerType') === 'external' ? 'external' : 'member',
    });
    return c.json({ success: true, data: tasks });
  });

  app.post('/api/server/workspace-tasks/migrate', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json() as { bundles?: any[] };
    if (!Array.isArray(body.bundles) || body.bundles.length === 0) {
      return c.json({ error: 'bundles array required' }, 400);
    }

    const results = [];
    for (const bundle of body.bundles) {
      results.push(await WorkspaceTaskService.upsertMigratedTaskBundle(server.id, bundle));
    }
    return c.json({ success: true, data: results });
  });

  app.get('/api/server/workspace-tasks/migration-summary', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const summary = await WorkspaceTaskService.getMigrationSummary(server.id);
    return c.json({ success: true, data: summary });
  });

  app.get('/api/server/workspace-tasks/:taskId', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);
    const task = await WorkspaceTaskService.getTaskById(server.id, c.req.param('taskId'), {
      includeAttachments: true,
      viewerId: c.req.query('viewerId') ?? undefined,
      viewerType: c.req.query('viewerType') === 'external' ? 'external' : 'member',
    });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, data: task });
  });

  app.patch('/api/server/workspace-tasks/:taskId', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json();
    // The workspace server proxies user-initiated updates via this route (it's
    // the broker between the browser and the BE). When the user triggers the
    // change it includes `actingUserId` so we can build a user actor and
    // self-suppression fires — without this the user gets a notification for
    // their own action. Without `actingUserId` the call is autonomous (agent
    // loop / job archival sweeper / etc.) and actor = agent.
    const actor = deriveServerTokenActor(body);
    // Strip the wire-only field so it doesn't leak into the service input.
    if (body && typeof body === 'object') delete (body as Record<string, unknown>).actingUserId;
    const { task, notification } = await WorkspaceTaskService.updateTask(
      server.id,
      c.req.param('taskId'),
      body,
      actor,
    );
    if (!task) return c.json({ error: 'Task not found' }, 404);
    // Ship the emitted notification (if any) back to the calling per-server
    // so it can push to its connected WS clients.
    return c.json({ success: true, data: task, notification });
  });

  app.post('/api/server/workspace-tasks/:taskId/upvote', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json();
    if (!body?.voterId || typeof body.voterId !== 'string') {
      return c.json({ error: 'voterId is required' }, 400);
    }

    const task = await WorkspaceTaskService.setTaskUpvote(server.id, c.req.param('taskId'), {
      voterId: body.voterId,
      voterType: body.voterType === 'external' ? 'external' : 'member',
      value: true,
    });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, data: task });
  });

  app.delete('/api/server/workspace-tasks/:taskId/upvote', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const voterId = c.req.query('voterId');
    const voterType = c.req.query('voterType');
    if (!voterId) return c.json({ error: 'voterId is required' }, 400);

    const task = await WorkspaceTaskService.setTaskUpvote(server.id, c.req.param('taskId'), {
      voterId,
      voterType: voterType === 'external' ? 'external' : 'member',
      value: false,
    });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    return c.json({ success: true, data: task });
  });

  app.post('/api/server/workspace-tasks/:taskId/comments', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const task = await WorkspaceTaskService.getTaskById(server.id, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const body = await c.req.json();
    const comment = await WorkspaceTaskService.addComment(server.id, task.id, body);
    return c.json({ success: true, data: comment }, 201);
  });

  app.delete('/api/server/workspace-tasks/:taskId/comments/:commentId', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const task = await WorkspaceTaskService.getTaskById(server.id, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    // Server-token path: the workspace server has already authorized the action
    // locally. Authoring identity is opaque to the BE here.
    const result = await WorkspaceTaskService.deleteComment(server.id, task.id, c.req.param('commentId'), {
      actorId: 'server-token',
      actorType: 'system',
      override: true,
    });
    if (result === 'not_found') return c.json({ error: 'Comment not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/api/server/workspace-tasks/:taskId/comments', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const task = await WorkspaceTaskService.getTaskById(server.id, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const comments = await WorkspaceTaskService.listComments(task.id);
    return c.json({ success: true, data: comments });
  });

  app.get('/api/server/workspace-tasks/:taskId/activity', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const task = await WorkspaceTaskService.getTaskById(server.id, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const activity = await WorkspaceTaskService.listActivity(task.id);
    return c.json({ success: true, data: activity });
  });

  app.post('/api/server/workspace-tasks/:taskId/activity', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const task = await WorkspaceTaskService.getTaskById(server.id, c.req.param('taskId'));
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const body = await c.req.json();
    const activity = await WorkspaceTaskService.addActivity(server.id, task.id, body);
    return c.json({ success: true, data: activity }, 201);
  });

  // ==========================================================================
  // Server-wide Activity Feed
  // ==========================================================================

  app.get('/api/server/activity-feed', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const userId = c.req.query('userId') || undefined;
    const type = c.req.query('type') || undefined;
    const excludeAgents = c.req.query('excludeAgents') === 'true';
    const limit = Math.max(1, Math.min(200, parseInt(c.req.query('limit') || '20', 10)));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

    const data = await listActivityFeed(server.id, { userId, type, excludeAgents, limit, offset });
    return c.json({ success: true, data });
  });

  app.get('/api/server/activity-feed/count-new', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const since = parseInt(c.req.query('since') || '0', 10);
    const count = await countNewActivity(server.id, since);
    return c.json({ success: true, data: { count } });
  });

  app.get('/api/server/activity-feed/member-stats', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const startDate = c.req.query('startDate') ? parseInt(c.req.query('startDate')!, 10) : undefined;
    const endDate = c.req.query('endDate') ? parseInt(c.req.query('endDate')!, 10) : undefined;
    const members = await activityMemberStats(server.id, startDate, endDate);
    return c.json({ success: true, data: { members } });
  });

  app.get('/api/server/activity-feed/member-activity', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const startDate = parseInt(c.req.query('startDate') || '0', 10);
    const endDate = parseInt(c.req.query('endDate') || String(Date.now()), 10);
    const granularity = (c.req.query('granularity') || 'day') as 'day' | 'week' | 'month';
    if (!['day', 'week', 'month'].includes(granularity)) {
      return c.json({ success: false, error: 'Invalid granularity. Must be day, week, or month.' }, 400);
    }
    const data = await activityMemberActivity(server.id, startDate, endDate, granularity);
    return c.json({ success: true, data });
  });

  // ==========================================================================
  // GitVote Widget Token (authenticated)
  // ==========================================================================

  app.get('/api/gitvote/widget-token', async (c) => {
    const gvKey = process.env.GITVOTE_WIDGET_KEY;
    if (!gvKey) {
      return c.json({ error: 'GitVote widget not configured' }, 503);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.substring(7);
    const userId = await extractUserIdFromToken(token);
    if (!userId) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    const user = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user.length) {
      return c.json({ error: 'User not found' }, 404);
    }

    const fp = createHash('sha256').update(gvKey).digest('hex').slice(0, 16);
    const payload = Buffer.from(JSON.stringify({
      sub: user[0].id,
      name: user[0].name ?? undefined,
      fp,
      iat: Math.floor(Date.now() / 1000),
    })).toString('base64url');
    const sig = createHmac('sha256', gvKey).update(payload).digest('base64url');

    return c.json({ token: `${payload}.${sig}` });
  });

  // ==========================================================================
  // Browserbase Session Creation (authenticated)
  // ==========================================================================
  // Client or server server calls this to get a CDP WebSocket URL for direct browser control.
  // The API key stays server-side; client only gets the session's connectUrl.
  // Accepts either user token or server token (wst_xxx).
  app.post('/api/browser/session', async (c) => {
    try {
      // Authenticate - supports both user tokens and server tokens (wst_xxx)
      const authHeader = c.req.header('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.substring(7);
      let identifier: string | null = null;

      console.log(`[HttpServer] Browser session request with token: ${token.substring(0, 10)}...`);

      // Check if it's a server token (server server)
      if (token.startsWith('wst_')) {
        console.log('[HttpServer] Token is a server token, looking up server...');
        const server = await ServerService.getServerByToken(token);
        if (server) {
          identifier = `server:${server.id}`;
          console.log(`[HttpServer] Found server: ${server.id}`);
        } else {
          console.log('[HttpServer] Server not found for token');
        }
      } else {
        // Try as user token
        console.log('[HttpServer] Token is not a server token, trying as user token...');
        identifier = await extractUserIdFromToken(token);
      }

      // Dev bypass: use first user if no valid identifier in development
      if (!identifier && process.env.NODE_ENV !== 'production') {
        const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
        if (firstUser) {
          identifier = firstUser.id;
          console.log('[HttpServer] Dev mode bypass: using first user for browser session:', identifier);
        }
      }

      if (!identifier) {
        console.log('[HttpServer] No valid identifier found, returning Unauthorized');
        return c.json({ error: 'Unauthorized' }, 401);
      }

      // Check Browserbase credentials
      const apiKey = process.env.BROWSERBASE_API_KEY;
      const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
      if (!apiKey || !browserbaseProjectId) {
        console.error('[HttpServer] Browserbase credentials not configured');
        return c.json({ error: 'Browser service not configured' }, 500);
      }

      // Create Browserbase session via their REST API
      // Set timeout to auto-terminate orphaned sessions (15 min idle, 30 min max)
      // NOTE: blockAds and fingerprint require Browserbase SDK, not REST API v1
      const response = await fetch('https://api.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bb-api-key': apiKey,
        },
        body: JSON.stringify({
          projectId: browserbaseProjectId,
          keepAlive: false,  // Don't keep alive after disconnect
          timeout: 900,      // 15 min idle timeout (seconds)
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[HttpServer] Browserbase session creation failed:', response.status, errorText);
        return c.json({ error: 'Failed to create browser session' }, 502);
      }

      const session = await response.json() as { id: string; connectUrl: string };
      console.log(`[HttpServer] Created Browserbase session ${session.id} for ${identifier}`);

      // Fetch the live view URL from Browserbase debug endpoint
      let liveViewUrl: string | null = null;
      try {
        const debugResponse = await fetch(`https://api.browserbase.com/v1/sessions/${session.id}/debug`, {
          headers: {
            'x-bb-api-key': apiKey,
          },
        });
        if (debugResponse.ok) {
          const debugInfo = await debugResponse.json() as { debuggerFullscreenUrl?: string };
          liveViewUrl = debugInfo.debuggerFullscreenUrl || null;
          console.log(`[HttpServer] Got live view URL for session ${session.id}`);
        }
      } catch (err) {
        console.warn(`[HttpServer] Failed to get live view URL:`, err);
      }

      return c.json({
        sessionId: session.id,
        connectUrl: session.connectUrl,
        liveViewUrl,
      });
    } catch (error) {
      console.error('[HttpServer] Browser session error:', error);
      return c.json({ error: 'Failed to create browser session' }, 500);
    }
  });

  // ==========================================================================
  // Widget Public API (called by widget.js from customer websites)
  // ==========================================================================

  /**
   * Map a thrown error from the WidgetService layer onto an HTTP response.
   *
   * `WidgetError` / `WidgetAssignError` carry a stable `.code` and `.status`
   * — callers can rely on these strings. Anything else is logged and reported
   * as `{error: 'internal'}` so DB / driver internals don't leak to the
   * unauthenticated public widget caller.
   */
  function widgetErrorResponse(c: any, err: unknown) {
    if (err instanceof WidgetService.WidgetError || err instanceof WidgetService.WidgetAssignError) {
      return c.json({ error: err.code }, err.status as any);
    }
    console.error('[widget] unhandled error:', err);
    return c.json({ error: 'internal' }, 500);
  }

  /**
   * Apply the per-action rate limit using the default limit table. Returns
   * a 429 response if the user is over quota, or `null` to let the caller
   * proceed.
   */
  function widgetRateLimit(
    c: any,
    projectId: string,
    widgetUserId: string,
    action: WidgetAction,
  ) {
    const rl = widgetRateLimiter.checkDefault(projectId, widgetUserId, action);
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    return null;
  }

  /**
   * Shared ready-path finalizer: used by both /assign (round-0-ready) and
   * /clarify-answer (ready after answering) and /clarify-proceed (override).
   *
   * When overrideDuplicate is false (default):
   *   - Runs the LLM dedup check against recent open tickets on the same server.
   *   - If a likely duplicate is found: records status='duplicate' on the
   *     clarification and returns { status: 'duplicate', clarificationId, duplicateOf }.
   *   - If no duplicate: falls through to assignAgent.
   *
   * When overrideDuplicate is true (human chose "not a duplicate, proceed"):
   *   - Skips the dedup check entirely.
   *
   * In the no-dup / override case: runs agent exposure recheck (TOCTOU guard
   * from Gate 5c), calls assignAgent with stored agent+command+qa, marks the
   * clarification started, and returns { status: 'started', jobId, agentId, clarificationId }.
   *
   * Throws on:
   *   - Agent not available (403-equivalent — caller checks exposed agents first
   *     for the assign path; this handles clarify-answer + clarify-proceed)
   *   - WidgetAssignError / WidgetError (assignAgent failures)
   */
  type FinalizeResult =
    | { kind: 'duplicate'; clarificationId: string; duplicateOf: string }
    | { kind: 'started'; clarificationId: string; jobId: string; agentId: string };

  async function finalizeReadyClarification(
    clar: {
      id: string;
      serverId: string;
      agentId: string;
      command: string;
      taskId: string;
      /** Title + description of the ticket — used for dedup candidate matching. */
      candidate: { title: string; description: string | null };
    },
    actor: {
      projectId: string;
      ticketId: string;
      widgetUserId: string;
      externalUserId: string;
      name: string | null;
      matchedRoles: string[];
    },
    options: {
      overrideDuplicate: boolean;
      /** Pre-fetched Q&A (from getAnsweredQa). Pass [] when not applicable (round-0 ready). */
      qa?: Array<{ question: string; answer: string }>;
    },
  ): Promise<FinalizeResult> {
    // --- Dedup gate (skipped when human explicitly overrides) ---
    if (!options.overrideDuplicate) {
      const dup = await DedupService.findLikelyDuplicate({
        serverId: clar.serverId,
        ticketId: clar.taskId,
        candidate: clar.candidate,
      });

      if (dup.duplicateOf !== null) {
        // Record the duplicate on the clarification row
        await ClarifierService.markDuplicate(clar.id, dup.duplicateOf);
        return { kind: 'duplicate', clarificationId: clar.id, duplicateOf: dup.duplicateOf };
      }
    }

    // --- Agent exposure recheck (TOCTOU guard) ---
    const exposed = await WidgetService.listExposedAgents(actor.projectId);
    if (!exposed.some((a) => a.id === clar.agentId)) {
      throw Object.assign(new Error('Agent not available'), { _agentNotAvailable: true });
    }

    // --- Start the job ---
    const result = await WidgetService.assignAgent(actor.projectId, actor.ticketId, {
      agentId: clar.agentId,
      command: clar.command,
      actor: {
        widgetUserId: actor.widgetUserId,
        externalUserId: actor.externalUserId,
        name: actor.name,
        matchedRoles: actor.matchedRoles,
      },
      ...(options.qa && options.qa.length > 0 ? { qa: options.qa } : {}),
    });

    await ClarifierService.markClarificationStarted(clar.id);

    return { kind: 'started', clarificationId: clar.id, jobId: result.jobId, agentId: clar.agentId };
  }

  // CORS for /api/widget/* (preflight, credentialed echo, X-RunHQ-CSRF
  // header allowlisting) is handled by the unified global middleware
  // registered at the top of createHttpApp. Per-route helpers are no
  // longer needed.

  // Public: list all public widget projects (no auth needed)
  app.get('/api/widget/projects', async (c) => {
    const projects = await WidgetService.listPublicProjects();
    return c.json({ projects });
  });

  app.get('/api/widget/agents', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (!auth.permissions.has('assign_agent')) return c.json({ error: 'Forbidden' }, 403);
    const agents = await WidgetService.listExposedAgents(auth.projectId);
    return c.json({ agents });
  });

  app.get('/api/widget/me', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({
      widgetUserId: auth.widgetUserId ?? null,
      permissions: Array.from(auth.permissions),
      matchedRoles: auth.matchedRoles,
      isTriager: auth.permissions.has('assign_agent'),
    });
  });

  /**
   * Bootstrap identity endpoint for the widget.
   *
   * Always returns 200 with an `identity` object describing whichever
   * auth path resolved (runhq | app | null). The widget calls this once
   * at init time to decide which header set to use on subsequent
   * requests (Authorization vs cookie+CSRF). A null identity means the
   * viewer is anonymous — callers should fall back to public-read or
   * the configured login-URL redirect flow.
   *
   * `csrfToken` is present iff identity.source === 'runhq'. Bearer auth
   * doesn't need CSRF (token is in a header, not a cookie).
   *
   * Distinct from /api/widget/me which 401s on unauth — that's the
   * legacy contract, kept for backward compatibility with already-
   * deployed widget bundles.
   */
  app.get('/api/widget/identity', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) {
      // Classify *why* a presented Bearer token was rejected so a
      // misconfigured embed can report the exact defect instead of
      // silently looking "anonymous". null = genuine anon (no token).
      const authError = await WidgetService.diagnoseWidgetBearerAuth(c.req);
      return c.json({ identity: null, csrfToken: null, authError });
    }
    return c.json({
      identity: {
        source: auth.authSource === 'runhq' ? 'runhq'
              : auth.authSource === 'app'   ? 'app'
              : null,
        widgetUserId: auth.widgetUserId ?? null,
        displayName: auth.displayName ?? null,
        avatarUrl: auth.avatarUrl ?? null,
      },
      permissions: Array.from(auth.permissions),
      matchedRoles: auth.matchedRoles,
      isTriager: auth.permissions.has('assign_agent'),
      csrfToken: auth.csrfToken ?? null,
    });
  });

  app.post('/api/widget/tickets/:id/suggest-assignment', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (!auth.permissions.has('assign_agent')) return c.json({ error: 'Forbidden' }, 403);
    const result = await WidgetService.suggestAssignment(auth.projectId, c.req.param('id'));
    return c.json(result);
  });

  app.post('/api/widget/tickets/:id/assign', async (c) => {
    // Gate 1: JWT auth
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Gate 2: assign_agent permission
    if (!auth.permissions.has('assign_agent')) return c.json({ error: 'Forbidden' }, 403);
    // Gate 3: identified user required (widgetUserId only present for JWT-signed requests with sub)
    if (!auth.widgetUserId) return c.json({ error: 'Identified user required' }, 401);

    // Gate 4: body validation
    const body = await c.req.json().catch(() => null) as { agentId?: unknown; command?: unknown } | null;
    if (!body || typeof body.agentId !== 'string' || typeof body.command !== 'string') {
      return c.json({ error: 'agentId and command required' }, 400);
    }

    // Gate 5: re-validate agent exposure
    const exposed = await WidgetService.listExposedAgents(auth.projectId);
    if (!exposed.some((a) => a.id === body.agentId)) {
      return c.json({ error: 'Agent not available' }, 403);
    }

    // Gate 6: rate limit (per-project override)
    const limitPerHour = await WidgetService.getWidgetProjectRateLimit(auth.projectId);
    const rl = widgetRateLimiter.check(auth.projectId, auth.widgetUserId, 'triager_assign', limitPerHour);
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }

    // Resolve external user details for audit
    const wu = await WidgetService.getWidgetUserAuditInfo(auth.widgetUserId);
    if (!wu) return c.json({ error: 'Widget user not found' }, 404);

    const ticketId = c.req.param('id');

    // Resolve project → serverId + ticket info for the clarification
    const ticketInfo = await WidgetService.getTicketForAssign(auth.projectId, ticketId);
    if (!ticketInfo) return c.json({ error: 'ticket_not_found' }, 404);

    // Start clarification; only proceed to assignAgent when the model returns 'ready'.
    let clarStep: Awaited<ReturnType<typeof ClarifierService.startClarification>>;
    try {
      clarStep = await ClarifierService.startClarification({
        serverId: ticketInfo.serverId,
        taskId: ticketId,
        widgetUserId: auth.widgetUserId,
        agentId: body.agentId,
        command: body.command,
        ticket: { title: ticketInfo.title, description: ticketInfo.description },
      });
    } catch (err) {
      console.error('[widget] clarifier failed:', err);
      return c.json({ error: 'clarifier_unavailable' }, 503);
    }

    if (clarStep.status === 'asking') {
      // Return questions to the caller — job NOT started yet
      return c.json({
        clarification: {
          clarificationId: clarStep.clarificationId,
          status: 'asking' as const,
          round: clarStep.round,
          questions: clarStep.questions,
        },
      });
    }

    // clarStep.status === 'ready' — run the shared finalize gate (dedup + assignAgent)
    let finalizeResult: FinalizeResult;
    try {
      finalizeResult = await finalizeReadyClarification(
        {
          id: clarStep.clarificationId,
          serverId: ticketInfo.serverId,
          agentId: body.agentId,
          command: body.command,
          taskId: ticketId,
          candidate: { title: ticketInfo.title, description: ticketInfo.description },
        },
        {
          projectId: auth.projectId,
          ticketId,
          widgetUserId: auth.widgetUserId,
          externalUserId: wu.externalUserId,
          name: wu.name,
          matchedRoles: auth.matchedRoles,
        },
        { overrideDuplicate: false, qa: [] },
      );
    } catch (err: any) {
      if (err?._agentNotAvailable) return c.json({ error: 'Agent not available' }, 403);
      return widgetErrorResponse(c, err);
    }

    if (finalizeResult.kind === 'duplicate') {
      return c.json({
        clarification: {
          clarificationId: finalizeResult.clarificationId,
          status: 'duplicate' as const,
          duplicateOf: finalizeResult.duplicateOf,
        },
      });
    }
    return c.json({ jobId: finalizeResult.jobId, agentId: body.agentId });
  });

  // ---------------------------------------------------------------------------
  // POST /api/widget/tickets/:id/clarify-answer
  //
  // The identified user who triggered the clarification (assigner) provides
  // answers to the clarifier's questions. We record the answers, re-run the
  // clarifier, and — when it returns 'ready' — start the job via assignAgent
  // using the agent+command stored on the clarification row.
  //
  // Error conventions mirror the assign route:
  //   ClarifierAnswerError → 400 invalid_answers
  //   Any other LLM/infra error → 503 clarifier_unavailable (fail-closed)
  // ---------------------------------------------------------------------------
  app.post('/api/widget/tickets/:id/clarify-answer', async (c) => {
    // Gate 1: JWT auth
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Gate 2: assign_agent permission (same gate as /assign — only assigners answer)
    if (!auth.permissions.has('assign_agent')) return c.json({ error: 'Forbidden' }, 403);
    // Gate 3: identified user required
    if (!auth.widgetUserId) return c.json({ error: 'Identified user required' }, 401);

    // Gate 4: body validation
    let body: { clarificationId: string; answers: Array<{ questionId: string; answer: string | string[] }> };
    try {
      const raw = await c.req.json() as unknown;
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as any).clarificationId !== 'string' ||
        !(raw as any).clarificationId ||
        !Array.isArray((raw as any).answers) ||
        (raw as any).answers.length === 0 ||
        !(raw as any).answers.every(
          (a: unknown) =>
            a !== null &&
            typeof a === 'object' &&
            typeof (a as any).questionId === 'string' &&
            (typeof (a as any).answer === 'string' || Array.isArray((a as any).answer)),
        )
      ) {
        return c.json({ error: 'invalid_body' }, 400);
      }
      body = raw as typeof body;
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }

    // Gate 5: load + ownership check (taskId + widgetUserId must match)
    const ticketId = c.req.param('id');
    const clar = await ClarifierService.getOwnedClarification(body.clarificationId, {
      taskId: ticketId,
      widgetUserId: auth.widgetUserId,
    });
    if (!clar) return c.json({ error: 'clarification_not_found' }, 404);

    // Gate 5b: explicit status guard — only 'asking' clarifications can accept answers.
    // Fails fast with 409 Conflict instead of relying on the indirect ClarifierAnswerError→400
    // path when the clarification is already 'ready'/'started'/'skipped'/'duplicate'.
    if (clar.status !== 'asking') {
      return c.json({ error: 'clarification_not_open' }, 409);
    }

    // Gate 6: rate limit (per-project override, shared 'triager_assign' bucket with /assign —
    // combined assign+answer quota per user).
    const limitPerHour = await WidgetService.getWidgetProjectRateLimit(auth.projectId);
    const rl = widgetRateLimiter.check(auth.projectId, auth.widgetUserId, 'triager_assign', limitPerHour);
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }

    // Submit answers and advance the clarifier.
    let step: Awaited<ReturnType<typeof ClarifierService.answerClarification>>;
    try {
      step = await ClarifierService.answerClarification(body.clarificationId, body.answers);
    } catch (err) {
      if (err instanceof ClarifierService.ClarifierAnswerError) {
        return c.json({ error: 'invalid_answers' }, 400);
      }
      console.error('[widget] clarifier answer failed:', err);
      return c.json({ error: 'clarifier_unavailable' }, 503);
    }

    if (step.status === 'asking') {
      // Still needs more information — return next round of questions, job NOT started.
      return c.json({
        clarification: {
          clarificationId: body.clarificationId,
          status: 'asking' as const,
          round: step.round,
          questions: step.questions,
        },
      });
    }

    // step.status === 'ready' — run the shared finalize gate (dedup + assignAgent).

    const wu = await WidgetService.getWidgetUserAuditInfo(auth.widgetUserId);
    if (!wu) return c.json({ error: 'widget_user_not_found' }, 404);

    const qa = await ClarifierService.getAnsweredQa(body.clarificationId);

    // Load ticket title/description for the dedup candidate (same call as /assign uses).
    const ticketInfoForDedup = await WidgetService.getTicketForAssign(auth.projectId, ticketId);

    let finalizeResult: FinalizeResult;
    try {
      finalizeResult = await finalizeReadyClarification(
        {
          id: clar.id,
          serverId: clar.serverId,
          agentId: clar.agentId,
          command: clar.command,
          taskId: ticketId,
          candidate: {
            title: ticketInfoForDedup?.title ?? '',
            description: ticketInfoForDedup?.description ?? null,
          },
        },
        {
          projectId: auth.projectId,
          ticketId,
          widgetUserId: auth.widgetUserId,
          externalUserId: wu.externalUserId,
          name: wu.name,
          matchedRoles: auth.matchedRoles,
        },
        { overrideDuplicate: false, qa },
      );
    } catch (err: any) {
      if (err?._agentNotAvailable) return c.json({ error: 'Agent not available' }, 403);
      return widgetErrorResponse(c, err);
    }

    if (finalizeResult.kind === 'duplicate') {
      return c.json({
        clarification: {
          clarificationId: finalizeResult.clarificationId,
          status: 'duplicate' as const,
          duplicateOf: finalizeResult.duplicateOf,
        },
      });
    }
    return c.json({
      jobId: finalizeResult.jobId,
      agentId: clar.agentId,
      clarification: { clarificationId: body.clarificationId, status: 'started' as const },
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/widget/tickets/:id/clarify-proceed
  //
  // Human override: the assigner has reviewed the "possible duplicate" signal
  // and decided to proceed anyway. Loads the owned clarification (must be
  // status='duplicate'), then calls finalizeReadyClarification with
  // overrideDuplicate=true — which skips the dedup check and starts the job.
  //
  // Gate conventions mirror /clarify-answer.
  // ---------------------------------------------------------------------------
  app.post('/api/widget/tickets/:id/clarify-proceed', async (c) => {
    // Gate 1: JWT auth
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // Gate 2: assign_agent permission
    if (!auth.permissions.has('assign_agent')) return c.json({ error: 'Forbidden' }, 403);
    // Gate 3: identified user required
    if (!auth.widgetUserId) return c.json({ error: 'Identified user required' }, 401);

    // Gate 4: body — clarificationId required
    let body: { clarificationId: string };
    try {
      const raw = await c.req.json() as unknown;
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as any).clarificationId !== 'string' ||
        !(raw as any).clarificationId
      ) {
        return c.json({ error: 'invalid_body' }, 400);
      }
      body = raw as typeof body;
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }

    // Gate 5: load + ownership check
    const ticketId = c.req.param('id');
    const clar = await ClarifierService.getOwnedClarification(body.clarificationId, {
      taskId: ticketId,
      widgetUserId: auth.widgetUserId,
    });
    if (!clar) return c.json({ error: 'clarification_not_found' }, 404);

    // Gate 5b: must be in 'duplicate' status to override
    if (clar.status !== 'duplicate') {
      return c.json({ error: 'clarification_not_open' }, 409);
    }

    const wu = await WidgetService.getWidgetUserAuditInfo(auth.widgetUserId);
    if (!wu) return c.json({ error: 'widget_user_not_found' }, 404);

    const qa = await ClarifierService.getAnsweredQa(body.clarificationId);

    let finalizeResult: FinalizeResult;
    try {
      finalizeResult = await finalizeReadyClarification(
        {
          id: clar.id,
          serverId: clar.serverId,
          agentId: clar.agentId,
          command: clar.command,
          taskId: ticketId,
          // candidate not used when overrideDuplicate=true; provide empty to satisfy type
          candidate: { title: '', description: null },
        },
        {
          projectId: auth.projectId,
          ticketId,
          widgetUserId: auth.widgetUserId,
          externalUserId: wu.externalUserId,
          name: wu.name,
          matchedRoles: auth.matchedRoles,
        },
        { overrideDuplicate: true, qa },
      );
    } catch (err: any) {
      if (err?._agentNotAvailable) return c.json({ error: 'Agent not available' }, 403);
      return widgetErrorResponse(c, err);
    }

    // With overrideDuplicate:true, the dedup gate is bypassed — kind is always 'started'
    if (finalizeResult.kind === 'duplicate') {
      // Should never happen with overrideDuplicate:true, but guard defensively
      return c.json({
        clarification: {
          clarificationId: finalizeResult.clarificationId,
          status: 'duplicate' as const,
          duplicateOf: finalizeResult.duplicateOf,
        },
      });
    }
    return c.json({
      jobId: finalizeResult.jobId,
      agentId: clar.agentId,
      clarification: { clarificationId: body.clarificationId, status: 'started' as const },
    });
  });

  // ---------------------------------------------------------------------------
  // Widget Chat — agent-intake conversations ("Chat with Agent" home card).
  // Same auth/CSRF/rate-limit middleware as ticket routes (authenticateWidget
  // enforces CSRF on cookie-auth writes). All conversation routes are
  // privacy-scoped: WidgetChatService verifies ownership and answers
  // conversation_not_found for non-owners (existence never leaks).
  // Anonymous gating mirrors ticket submission; per the chat contract anon
  // gets 403 (the widget shows its login-prompt path).
  // ---------------------------------------------------------------------------

  function chatMessageDto(m: WidgetChatService.ChatMessageRow) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      payload: m.payload ?? null,
      turnId: m.turnId ?? null,
      seq: m.seq ?? null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  function chatConversationDto(conv: {
    id: string; status: string; createdTaskId: string | null;
    userTurnCount: number; pendingTurnId: string | null;
    createdAt: Date; updatedAt: Date;
  }) {
    return {
      id: conv.id,
      status: conv.status,
      createdTaskId: conv.createdTaskId,
      userTurnCount: conv.userTurnCount,
      pendingTurnId: conv.pendingTurnId,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    };
  }

  /** Shared gate: identified widget user required (403 for anon per chat contract). */
  async function requireChatUser(c: any): Promise<
    | { auth: Awaited<ReturnType<typeof WidgetService.authenticateWidget>> & { widgetUserId: string } }
    | { response: Response }
  > {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return { response: c.json({ error: 'Unauthorized' }, 401) };
    if (!auth.authenticated || !auth.widgetUserId) {
      return { response: c.json({ error: 'identified_user_required' }, 403) };
    }
    return { auth: auth as any };
  }

  // Start-or-resume the user's active conversation (+ last 50 messages).
  app.post('/api/widget/chat/conversations', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    try {
      const { conversation, messages } = await WidgetChatService.getOrCreateActiveConversation(
        auth.projectId, auth.widgetUserId,
      );
      return c.json({ conversation: chatConversationDto(conversation), messages: messages.map(chatMessageDto) });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.get('/api/widget/chat/conversations/active', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    try {
      const bundle = await WidgetChatService.getActiveConversation(auth.projectId, auth.widgetUserId);
      if (!bundle) return c.json({ error: 'not_found' }, 404);
      return c.json({
        conversation: chatConversationDto(bundle.conversation),
        messages: bundle.messages.map(chatMessageDto),
      });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  // Polling fallback: ?after=<message id> returns strictly newer rows.
  app.get('/api/widget/chat/conversations/:id/messages', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    try {
      const messages = await WidgetChatService.listMessages(
        c.req.param('id'), auth.projectId, auth.widgetUserId, c.req.query('after') || undefined,
      );
      return c.json({ messages: messages.map(chatMessageDto) });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  // Send a user message → triggers a workspace turn.
  app.post('/api/widget/chat/conversations/:id/messages', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'chat_message');
    if (limited) return limited;
    const body = await c.req.json().catch(() => null) as { content?: unknown } | null;
    if (!body || typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
    try {
      const message = await WidgetChatService.sendUserMessage(
        c.req.param('id'), auth.projectId, auth.widgetUserId, body.content,
      );
      return c.json({ message: chatMessageDto(message) });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  // Anti-AI-jail escape hatch: force the next turn to propose a ticket.
  app.post('/api/widget/chat/conversations/:id/force-proposal', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'chat_message');
    if (limited) return limited;
    try {
      await WidgetChatService.forceProposal(c.req.param('id'), auth.projectId, auth.widgetUserId);
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  // User confirmed the proposal card (possibly edited).
  app.post('/api/widget/chat/conversations/:id/create-ticket', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'ticket_create');
    if (limited) return limited;
    const body = await c.req.json().catch(() => null) as { title?: unknown; description?: unknown } | null;
    if (!body || typeof body.title !== 'string' || typeof body.description !== 'string') {
      return c.json({ error: 'title and description required' }, 400);
    }
    try {
      const result = await WidgetChatService.createTicketFromChat(
        c.req.param('id'), auth.projectId, auth.widgetUserId,
        { title: body.title, description: body.description },
      );
      return c.json({ ticketId: result.ticketId });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.post('/api/widget/chat/conversations/:id/dismiss-proposal', async (c) => {
    const gate = await requireChatUser(c);
    if ('response' in gate) return gate.response;
    const { auth } = gate;
    try {
      await WidgetChatService.dismissProposal(c.req.param('id'), auth.projectId, auth.widgetUserId);
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  // SSE stream of new messages. EventSource cannot set headers, so app-JWT
  // embeds pass ?token=<widget JWT> (shimmed into Authorization below);
  // runhq cookie auth works natively (withCredentials). Heartbeat comment
  // every 25s. ?after=<message id> replays rows the client may have missed
  // between its last fetch and this subscription (clients dedupe by id).
  app.get('/api/widget/chat/conversations/:id/events', async (c) => {
    const tokenQ = c.req.query('token');
    const reqForAuth = tokenQ && !c.req.header('Authorization')
      ? {
          header: (name: string) =>
            name.toLowerCase() === 'authorization' ? `Bearer ${tokenQ}` : c.req.header(name),
          method: 'GET',
          raw: c.req.raw,
        }
      : c.req;
    const auth = await WidgetService.authenticateWidget(reqForAuth as any);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (!auth.authenticated || !auth.widgetUserId) {
      return c.json({ error: 'identified_user_required' }, 403);
    }
    const conversationId = c.req.param('id');
    try {
      await WidgetChatService.getConversationOwned(conversationId, auth.projectId, auth.widgetUserId);
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
    const after = c.req.query('after') || undefined;
    const widgetUserId = auth.widgetUserId;
    const projectId = auth.projectId;

    return streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = WidgetChatService.subscribeToConversation(conversationId, (row) => {
        void stream.writeSSE({ event: 'message', id: row.id, data: JSON.stringify(chatMessageDto(row)) });
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      if (after) {
        try {
          const missed = await WidgetChatService.listMessages(conversationId, projectId, widgetUserId, after);
          for (const m of missed) {
            await stream.writeSSE({ event: 'message', id: m.id, data: JSON.stringify(chatMessageDto(m)) });
          }
        } catch {
          // invalid cursor → client falls back to a full refetch via the messages endpoint
        }
      }
      while (open) {
        await stream.sleep(25_000);
        if (!open) break;
        await stream.write(': hb\n\n');
      }
    });
  });

  app.get('/api/widget/tickets', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const result = await WidgetService.listTickets(auth.projectId, auth.widgetUserId);
    return c.json(result);
  });

  app.get('/api/widget/tickets/mine', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'Unauthorized' }, 401);
    const tickets = await WidgetService.listMyTickets(auth.projectId, auth.widgetUserId);
    return c.json({ tickets });
  });

  app.get('/api/widget/tickets/stats', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const stats = await WidgetService.getTicketStats(auth.projectId);
    return c.json(stats);
  });

  app.get('/api/widget/tickets/updates', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const result = await WidgetService.listPublishedTickets(auth.projectId, auth.widgetUserId);
    return c.json(result);
  });

  app.get('/api/widget/tickets/:id', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const detail = await WidgetService.getPublicTicketDetail(auth.projectId, c.req.param('id'), auth.widgetUserId);
    if (!detail) return c.json({ error: 'Ticket not found' }, 404);
    return c.json(detail);
  });

  app.post('/api/widget/tickets', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'ticket_create');
    if (limited) return limited;
    try {
      const body = await c.req.json();
      const ticket = await WidgetService.createTicket(auth.projectId, auth.widgetUserId, body);
      return c.json({ ticket }, 201);
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.post('/api/widget/tickets/:id/vote', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'vote');
    if (limited) return limited;
    try {
      const { value } = await c.req.json();
      await WidgetService.castVote(auth.projectId, c.req.param('id'), auth.widgetUserId, value);
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.delete('/api/widget/tickets/:id/vote', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'vote');
    if (limited) return limited;
    try {
      await WidgetService.retractVote(auth.projectId, c.req.param('id'), auth.widgetUserId);
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.patch('/api/widget/tickets/:id', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'ticket_update');
    if (limited) return limited;
    try {
      const body = await c.req.json();
      const ticket = await WidgetService.updateTicket(c.req.param('id'), auth.projectId, auth.widgetUserId, body);
      return c.json({ ticket });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.delete('/api/widget/tickets/:id', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'ticket_delete');
    if (limited) return limited;
    try {
      await WidgetService.deleteTicket(c.req.param('id'), auth.projectId, auth.widgetUserId);
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.post('/api/widget/tickets/:id/attachments', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'attachment_upload');
    if (limited) return limited;
    try {
      const formData = await c.req.raw.formData();
      const file = formData.get('file');
      if (!file || typeof (file as any).arrayBuffer !== 'function') {
        return c.json({ error: 'file_required' }, 400);
      }

      const inputFile = file as globalThis.File;
      const buffer = Buffer.from(await inputFile.arrayBuffer());
      const mimeType = inputFile.type || 'application/octet-stream';
      const filename = inputFile.name || 'attachment';

      const attachment = await WidgetService.uploadTicketAttachment(
        c.req.param('id'),
        auth.projectId,
        auth.widgetUserId,
        { buffer, mimeType, filename, originalName: inputFile.name },
      );
      return c.json({ attachment }, 201);
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.delete('/api/widget/tickets/:id/attachments/:attachmentId', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    // Deletes share the upload bucket — they're cheap and rare; reuse the
    // same budget rather than introduce a fourth attachment-related limit.
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'attachment_upload');
    if (limited) return limited;
    try {
      await WidgetService.deleteTicketAttachment(
        c.req.param('id'),
        c.req.param('attachmentId'),
        auth.projectId,
        auth.widgetUserId,
      );
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.post('/api/widget/tickets/:id/comments', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'comment_create');
    if (limited) return limited;
    try {
      const body = await c.req.json();
      const comment = await WidgetService.addWidgetComment(auth.projectId, c.req.param('id'), auth.widgetUserId, body.content);
      return c.json({ comment }, 201);
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.patch('/api/widget/tickets/:id/comments/:commentId', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'comment_update');
    if (limited) return limited;
    try {
      const body = await c.req.json();
      const comment = await WidgetService.updateWidgetComment(auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId, body.content);
      return c.json({ comment });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.delete('/api/widget/tickets/:id/comments/:commentId', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'comment_delete');
    if (limited) return limited;
    try {
      await WidgetService.deleteWidgetComment(auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId);
      return c.json({ ok: true });
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  app.post('/api/widget/tickets/:id/comments/:commentId/attachments', async (c) => {
    const auth = await WidgetService.authenticateWidget(c.req);
    if (!auth?.authenticated || !auth.widgetUserId) return c.json({ error: 'unauthorized' }, 401);
    const limited = widgetRateLimit(c, auth.projectId, auth.widgetUserId, 'attachment_upload');
    if (limited) return limited;
    try {
      const formData = await c.req.raw.formData();
      const file = formData.get('file');
      if (!file || typeof (file as any).arrayBuffer !== 'function') {
        return c.json({ error: 'file_required' }, 400);
      }
      const inputFile = file as globalThis.File;
      const buffer = Buffer.from(await inputFile.arrayBuffer());
      const attachment = await WidgetService.addWidgetCommentAttachment(
        auth.projectId, c.req.param('id'), c.req.param('commentId'), auth.widgetUserId,
        { buffer, mimeType: inputFile.type || 'application/octet-stream', filename: inputFile.name || 'attachment', originalName: inputFile.name },
      );
      return c.json({ attachment }, 201);
    } catch (err) {
      return widgetErrorResponse(c, err);
    }
  });

  // ==========================================================================
  // Widget Management API (called by RunHQ frontend UI)
  // ==========================================================================

  // Widget management auth: cloud-op permission (owner OR is_admin mirror).
  // Local BE check — works when workspace is crashed.
  async function requireWidgetAdmin(c: any, userId: string, serverId: string): Promise<boolean> {
    return ServerService.checkCloudOpPermission(serverId, userId);
  }

  // Build the project-keyed `WidgetLookup` from a request-supplied projectId
  // (the workspaceProjectId), or return null so the caller can emit a uniform
  // 400 `{ error: 'projectId required' }`. The widget is one-per-project;
  // channelId is now the target list, carried separately in enable/settings bodies.
  function parseWidgetLookup(
    projectId: string | undefined | null,
  ): WidgetService.WidgetLookup | null {
    if (projectId) return { workspaceProjectId: projectId };
    return null;
  }

  // Fire-and-forget: tell the preview proxy to drop its widget config cache
  // for this server. Called after ANY widget mutation that could change the
  // shouldInject flag or the bootstrap payload — i.e. enable, disable,
  // settings update — not just when auto-inject flips. Otherwise a machine
  // that booted with the widget disabled would keep injecting `false` after
  // a re-enable, because `auto_inject_in_preview` didn't change in the DB.
  //
  // `projectId` is optional: when the admin route was hit via `?channelId=`
  // (no projectId known to the BE), we omit the field from the JSON body
  // entirely. The workspace-side handler (preview-internal.ts) then treats
  // an absent projectId as "clear the whole server's widget cache", which
  // is the intended fallback. Coercing to `''` would silently break this —
  // the downstream cache helper treats `''` as a defined-but-no-match key
  // and clears nothing. See PR review note on Issue #1.
  //
  // Failures (machine stopped, network error) are intentionally swallowed:
  // the machine will re-fetch on its next boot anyway.
  function pushInvalidateWidgetCache(serverId: string, userId: string, projectId: string | undefined): void {
    (async () => {
      try {
        const server = await ServerService.getServer(serverId);
        if (!server?.serverUrl) return;
        const body: { kind: 'widget'; projectId?: string } = { kind: 'widget' };
        if (projectId !== undefined) body.projectId = projectId;
        await ServerService.fetchFromServer(server, userId, '/__preview/config-invalidate', {
          method: 'POST',
          body,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log('[HttpServer] Widget config push failed (safe, machine may be stopped):', msg);
      }
    })();
  }

  app.get('/api/widget/integration', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const lookup = parseWidgetLookup(c.req.query('projectId'));
    if (!lookup) return c.json({ error: 'projectId required' }, 400);
    if (!await requireWidgetAdmin(c, userId, serverId)) return c.json({ error: 'Forbidden' }, 403);
    const integration = await WidgetService.getWidgetIntegration(serverId, lookup);
    return c.json({ success: true, data: integration });
  });

  app.post('/api/widget/enable', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const { serverId, projectId, name, channelId } = await c.req.json();
    if (!serverId || !name) return c.json({ error: 'serverId and name required' }, 400);
    // Widget is one-per-project: projectId is the identity, channelId the target list.
    if (!projectId) return c.json({ error: 'projectId required' }, 400);
    if (!channelId) return c.json({ error: 'channelId required' }, 400);
    if (!await requireWidgetAdmin(c, userId, serverId)) return c.json({ error: 'Forbidden' }, 403);
    const result = await WidgetService.enableWidget(serverId, {
      name,
      channelId,
      workspaceProjectId: projectId,
    });
    pushInvalidateWidgetCache(serverId, userId, projectId);
    return c.json({ success: true, data: result });
  });

  app.post('/api/widget/reconcile', async (c) => {
    const serverToken = c.req.header('X-Server-Token');
    if (!serverToken) return c.json({ error: 'Server token required' }, 401);
    const server = await ServerService.getServerByToken(serverToken);
    if (!server) return c.json({ error: 'Invalid server token' }, 401);

    const body = await c.req.json().catch(() => null);
    const channelToProject = (body?.channelToProject ?? {}) as Record<string, string>;
    const projectToPrimaryTodoChannel = (body?.projectToPrimaryTodoChannel ?? {}) as Record<string, string>;
    if (typeof channelToProject !== 'object' || Array.isArray(channelToProject)) {
      return c.json({ error: 'channelToProject must be object' }, 400);
    }
    if (typeof projectToPrimaryTodoChannel !== 'object' || Array.isArray(projectToPrimaryTodoChannel)) {
      return c.json({ error: 'projectToPrimaryTodoChannel must be object' }, 400);
    }

    const result = await WidgetService.reconcileWidgetBindings(server.id, {
      channelToProject,
      projectToPrimaryTodoChannel,
    });
    return c.json({ success: true, data: result });
  });

  app.delete('/api/widget/disable', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const projectId = c.req.query('projectId') ?? undefined;
    const lookup = parseWidgetLookup(projectId);
    if (!lookup) return c.json({ error: 'projectId required' }, 400);
    if (!await requireWidgetAdmin(c, userId, serverId)) return c.json({ error: 'Forbidden' }, 403);
    await WidgetService.disableWidget(serverId, lookup);
    // Preview-proxy cache invalidation: pass the projectId when the route
    // received one (still read from the query for callers that supply it).
    // When omitted, the helper drops the field from the payload so the
    // workspace clears the whole server's widget cache (the correct
    // fallback — there's no way to translate channelId→projectId here
    // without an extra DB hop).
    pushInvalidateWidgetCache(serverId, userId, projectId);
    return c.json({ success: true });
  });

  app.post('/api/widget/secret/regenerate', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const { serverId, projectId } = await c.req.json();
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const lookup = parseWidgetLookup(projectId);
    if (!lookup) return c.json({ error: 'projectId required' }, 400);
    if (!await requireWidgetAdmin(c, userId, serverId)) return c.json({ error: 'Forbidden' }, 403);
    try {
      const result = await WidgetService.regenerateSecret(serverId, lookup);
      return c.json({ success: true, data: result });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // Generate a signed widget JWT for the RunHQ feedback widget.
  // Secret is server-side config — never accepted from the client and never
  // hard-coded. The endpoint reports 503 when the env var is missing.
  const FEEDBACK_WIDGET_SECRET = process.env.FEEDBACK_WIDGET_SECRET ?? '';

  app.get('/api/widget/user-token', async (c) => {
    if (!FEEDBACK_WIDGET_SECRET) return c.json({ error: 'Feedback widget not configured' }, 503);
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    const result = await WidgetService.generateUserTokenBySecret(FEEDBACK_WIDGET_SECRET, userId, user?.name || undefined);
    if (!result) return c.json({ error: 'Feedback widget not enabled' }, 404);
    return c.json({ success: true, data: result });
  });

  app.get('/api/widget/settings', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const serverId = c.req.query('serverId');
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const lookup = parseWidgetLookup(c.req.query('projectId'));
    if (!lookup) return c.json({ error: 'projectId required' }, 400);
    if (!await requireWidgetAdmin(c, userId, serverId)) return c.json({ error: 'Forbidden' }, 403);
    const settings = await WidgetService.getWidgetSettings(serverId, lookup);
    return c.json({ success: true, data: settings });
  });

  app.put('/api/widget/settings', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
    const userId = await extractUserIdFromToken(authHeader.substring(7));
    if (!userId) return c.json({ error: 'Invalid token' }, 401);
    const {
      serverId,
      projectId,
      channelId,
      auto_approve,
      widget_position,
      widget_language,
      voting_period_hours,
      is_public,
      login_url,
      allowed_origins,
      auto_recognize_runhq_members,
      auto_inject_in_preview,
      slug,
      widgetAgentAssignmentEnabled,
      widgetAssignRoles,
      widgetRoleClaimName,
      widgetAssignRateLimitPerHour,
      widgetChatAgentEntityId,
      widgetChatInstructions,
    } = await c.req.json();
    if (!serverId) return c.json({ error: 'serverId required' }, 400);
    const lookup = parseWidgetLookup(projectId);
    if (!lookup) return c.json({ error: 'projectId required' }, 400);
    if (!await requireWidgetAdmin(c, userId, serverId)) return c.json({ error: 'Forbidden' }, 403);

    let result: Awaited<ReturnType<typeof WidgetService.updateWidgetSettings>>;
    try {
      result = await WidgetService.updateWidgetSettings(serverId, {
        auto_approve, widget_position, widget_language, voting_period_hours, is_public, login_url, allowed_origins, auto_recognize_runhq_members, auto_inject_in_preview, slug,
        channelId,
        widgetAgentAssignmentEnabled,
        widgetAssignRoles,
        widgetRoleClaimName,
        widgetAssignRateLimitPerHour,
        widgetChatAgentEntityId,
        widgetChatInstructions,
      }, lookup);
    } catch (err) {
      if (err instanceof WidgetService.WidgetSettingsValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    // Always push-invalidate on widget settings changes — not just when
    // `autoInjectInPreview` flipped. Other fields (widget_position, slug, etc.)
    // flow into the widget bootstrap payload, and limiting to the flag alone
    // misses re-enable-after-disable scenarios where the DB value didn't
    // change but the effective shouldInject did.
    // When the route was hit via `channelId` only, `projectId` is undefined
    // and the helper omits it — see pushInvalidateWidgetCache for details.
    pushInvalidateWidgetCache(serverId, userId, projectId);
    // `result.autoInjectChanged` is returned for callers that care (telemetry,
    // audit logs); we don't branch on it here.
    void result;

    return c.json({ success: true });
  });

  // Legacy sync endpoints (unsynced, mark-synced, status) removed —
  // workspace_tasks is now the single source of truth.

  // ============================================================================
  // Notification REST endpoints
  // ============================================================================
  //
  // Auth pattern: reuse the established harnessRequireUser / harnessRequireAdmin
  // helpers defined earlier in createHttpApp(). These closures are available
  // because the routes are registered inside the same function body.

  // GET /api/notifications?limit=200
  app.get('/api/notifications', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
    const rows = await db.query.notifications.findMany({
      where: and(eq(notifications.userId, userId), isNull(notifications.archivedAt)),
      orderBy: [desc(notifications.createdAt)],
      limit,
    });
    return c.json({ notifications: rows.map(serializeNotification) });
  });

  // PATCH /api/notifications/:id  { read?: boolean, archived?: boolean }
  // NOTE: constrain :id to a UUID. Without this, the param route shadows the
  // static sibling routes registered after it (e.g. PATCH
  // /api/notifications/preferences would match here with id="preferences",
  // hit the no-read/archived-field branch, and 400 with "no_fields").
  app.patch('/api/notifications/:id{[0-9a-fA-F-]{36}}', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const id = c.req.param('id');
    const body = await c.req.json() as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.read === true)      patch.readAt = new Date();
    if (body.read === false)     patch.readAt = null;
    if (body.archived === true)  patch.archivedAt = new Date();
    if (body.archived === false) patch.archivedAt = null;
    if (!Object.keys(patch).length) return c.json({ error: 'no_fields' }, 400);
    await db
      .update(notifications)
      .set(patch)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
    return c.json({ ok: true });
  });

  // POST /api/notifications/mark-all-read
  app.post('/api/notifications/mark-all-read', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return c.json({ ok: true });
  });

  // POST /api/notifications/test
  // Fires a real notification to the calling user through the full delivery
  // pipeline (in_app toast via WS + web_push OS notification if a device is
  // registered). Lets users self-verify their setup without orchestrating a
  // real job transition — and unlike task notifications, it is intentionally
  // NOT self-suppressed (you are deliberately notifying yourself).
  app.post('/api/notifications/test', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;

    // Reflect the user's real channel config so the test result is honest:
    // a disabled channel is gated out exactly as it would be for a real ping.
    const prefs = await getOrCreatePreferences(userId);
    const subs = await db.query.pushSubscriptions.findMany({
      where: eq(pushSubscriptions.userId, userId),
    });
    const hasWebPushDevice = subs.some((s) => s.platform === 'web_push');

    let notificationId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        notificationId = await insertNotificationWithDeliveries(tx, {
          userId,
          // Synthetic server/project ids that match no mute and no real
          // workspace. serverId/projectId are free-form text; taskId is a uuid
          // column, so it must be a valid UUID even though no such task exists.
          serverId: 'test',
          serverName: 'Test',
          projectId: '',
          projectName: '',
          taskId: crypto.randomUUID(),
          taskTitle: 'This is a test notification 🔔',
          channelId: null,
          jobId: null,
          eventType: 'completed',
        });
      });
    } catch (err) {
      console.error('[notif:test] insert failed', { userId }, err);
      return c.json({ error: 'internal_error' }, 500);
    }

    if (!notificationId) return c.json({ error: 'not_created' }, 500);
    void dispatchNotification(notificationId).catch((err) =>
      console.warn('[notif:test] dispatch failed', err),
    );

    return c.json({
      ok: true,
      notification_id: notificationId,
      // Tell the client what to expect so the UI can guide the user.
      in_app: prefs.inAppEnabled,
      web_push: prefs.pushEnabled && hasWebPushDevice,
      web_push_no_device: prefs.pushEnabled && !hasWebPushDevice,
    });
  });

  // GET /api/notifications/preferences
  app.get('/api/notifications/preferences', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const prefs = await getOrCreatePreferences(userId);
    return c.json({
      preferences: {
        in_app_enabled:  prefs.inAppEnabled,
        browser_enabled: prefs.browserEnabled,
        push_enabled:    prefs.pushEnabled,
        email_enabled:   prefs.emailEnabled,
      },
    });
  });

  // PATCH /api/notifications/preferences
  app.patch('/api/notifications/preferences', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch (err) {
      console.error('[notif:prefs] bad JSON body', err);
      return c.json({ error: 'invalid_json' }, 400);
    }
    try {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof body.in_app_enabled === 'boolean')  patch.inAppEnabled = body.in_app_enabled;
      if (typeof body.browser_enabled === 'boolean') patch.browserEnabled = body.browser_enabled;
      if (typeof body.push_enabled === 'boolean')    patch.pushEnabled = body.push_enabled;
      if (typeof body.email_enabled === 'boolean')   patch.emailEnabled = body.email_enabled;
      await db
        .insert(userNotificationPreferences)
        .values({ userId, ...(patch as any) })
        .onConflictDoUpdate({ target: userNotificationPreferences.userId, set: patch as any });
      const fresh = await getOrCreatePreferences(userId);
      try {
        broadcastToUser(getWsServer(), userId, {
          type: 'notification:preferences-updated',
          preferences: {
            in_app_enabled:  fresh.inAppEnabled,
            browser_enabled: fresh.browserEnabled,
            push_enabled:    fresh.pushEnabled,
            email_enabled:   fresh.emailEnabled,
          },
        });
      } catch { /* WS not registered — API response suffices */ }
      return c.json({ ok: true });
    } catch (err) {
      console.error('[notif:prefs] PATCH failed', { userId, body }, err);
      return c.json({ error: 'internal_error' }, 500);
    }
  });

  // GET /api/notifications/mutes
  app.get('/api/notifications/mutes', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const rows = await db.query.notificationMutes.findMany({
      where: eq(notificationMutes.userId, userId),
    });
    return c.json({
      mutes: rows.map((r) => ({
        scope_type: r.scopeType,
        scope_id:   r.scopeId,
        expires_at: r.expiresAt?.toISOString() ?? null,
      })),
    });
  });

  // POST /api/notifications/mutes
  app.post('/api/notifications/mutes', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const body = await c.req.json() as { scope_type: 'server' | 'project'; scope_id: string; duration_ms: number | null };
    const expiresAt = body.duration_ms === null ? null : new Date(Date.now() + Number(body.duration_ms));
    await db
      .insert(notificationMutes)
      .values({ userId, scopeType: body.scope_type, scopeId: body.scope_id, expiresAt })
      .onConflictDoUpdate({
        target: [notificationMutes.userId, notificationMutes.scopeType, notificationMutes.scopeId],
        set: { expiresAt },
      });
    try {
      broadcastToUser(getWsServer(), userId, {
        type: 'notification:mute-updated',
        scope_type: body.scope_type,
        scope_id:   body.scope_id,
        expires_at: expiresAt?.toISOString() ?? null,
      });
    } catch { /* WS not registered */ }
    return c.json({ ok: true });
  });

  // DELETE /api/notifications/mutes/:scope_type/:scope_id
  app.delete('/api/notifications/mutes/:scope_type/:scope_id', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const scopeType = c.req.param('scope_type') as 'server' | 'project';
    const scopeId   = c.req.param('scope_id');
    await db
      .delete(notificationMutes)
      .where(
        and(
          eq(notificationMutes.userId, userId),
          eq(notificationMutes.scopeType, scopeType),
          eq(notificationMutes.scopeId, scopeId),
        ),
      );
    try {
      broadcastToUser(getWsServer(), userId, {
        type: 'notification:mute-updated',
        scope_type: scopeType,
        scope_id:   scopeId,
        expires_at: 'unmute',
      });
    } catch { /* WS not registered */ }
    return c.json({ ok: true });
  });

  // POST /api/notifications/push-subscriptions
  app.post('/api/notifications/push-subscriptions', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const body = await c.req.json() as {
      platform: 'web_push' | 'apns' | 'fcm';
      endpoint: string;
      keys: unknown;
      user_agent?: string;
    };
    await db
      .insert(pushSubscriptions)
      .values({
        userId,
        platform:  body.platform,
        endpoint:  body.endpoint,
        keys:      body.keys as any,
        userAgent: body.user_agent ?? null,
      })
      .onConflictDoNothing();
    return c.json({ ok: true });
  });

  // GET /api/notifications/push-subscriptions
  app.get('/api/notifications/push-subscriptions', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const rows = await db.query.pushSubscriptions.findMany({
      where: eq(pushSubscriptions.userId, userId),
    });
    return c.json({
      subscriptions: rows.map((r) => ({
        id:           r.id,
        platform:     r.platform,
        user_agent:   r.userAgent,
        created_at:   r.createdAt.toISOString(),
        last_used_at: r.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  // DELETE /api/notifications/push-subscriptions/:endpoint
  app.delete('/api/notifications/push-subscriptions/:endpoint', async (c) => {
    const userIdOrRes = await harnessRequireUser(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const userId = userIdOrRes;
    const endpoint = decodeURIComponent(c.req.param('endpoint'));
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
    return c.json({ ok: true });
  });

  // GET /admin/notifications/dead  (admin only)
  app.get('/admin/notifications/dead', async (c) => {
    const userIdOrRes = await harnessRequireAdmin(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const rows = await db.query.notificationDeliveries.findMany({
      where: eq(notificationDeliveries.status, 'dead'),
      orderBy: [desc(notificationDeliveries.createdAt)],
      limit: 200,
    });
    return c.json({ rows });
  });

  // POST /admin/notifications/dead/:id/requeue  (admin only)
  app.post('/admin/notifications/dead/:id/requeue', async (c) => {
    const userIdOrRes = await harnessRequireAdmin(c);
    if (typeof userIdOrRes !== 'string') return userIdOrRes;
    const id = c.req.param('id');
    await db
      .update(notificationDeliveries)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(eq(notificationDeliveries.id, id));
    return c.json({ ok: true });
  });

  // Mount OAuth routes
  app.route('/oauth', oauth);

  if (isGithubAppConfigured()) {
    registerGithubRoutes(app, {
      config: getGithubAppConfig(),
      // The /github/installed page is a CLIENT SPA route (app.runhq.io), not a
      // BE-hosted one — must use CLIENT_URL. APP_URL is the BE's own origin
      // (console.runhq.io in prod), which has no such route and bounces to login.
      clientUrl: process.env.CLIENT_URL ?? 'https://app.runhq.io',
      getServerByToken: (t) => ServerService.getServerByToken(t),
      upsertInstallation: GithubInstallationsService.upsertInstallation,
      removeInstallation: GithubInstallationsService.removeInstallation,
      getInstallation: GithubInstallationsService.getInstallation,
      associateWithWorkspace: GithubInstallationsService.associateWithWorkspace,
      isAssociatedWithWorkspace: GithubInstallationsService.isAssociatedWithWorkspace,
      mintInstallationToken: (id) => getGitHubAppService().mintInstallationToken(id),
      fetchInstallationAccount: (id) => getGitHubAppService().getInstallationAccount(id),
      prLinked: {
        findByOwnerRepo: GithubProjectReposService.findByOwnerRepo,
        parseTaskShareId: WorkspaceTaskService.parseTaskShareId,
        resolveTaskCandidates: WorkspaceTaskService.resolveTaskCandidates,
        listActivity: WorkspaceTaskService.listActivity,
        addActivity: async (serverId, taskId, input) => {
          await WorkspaceTaskService.addActivity(serverId, taskId, input);
        },
        updateTask: async (serverId, taskId, input) => {
          await WorkspaceTaskService.updateTask(serverId, taskId, input);
        },
        updateActivityMetadata: WorkspaceTaskService.updateActivityMetadata,
      },
    });
    registerInternalGithubRoutes(app, {
      stateSecret: getGithubAppConfig().stateSecret,
      appSlug: getGithubAppConfig().appSlug,
      getServerByToken: (t) => ServerService.getServerByToken(t),
      listInstallationsForServer: GithubInstallationsService.listInstallationsForServer,
      listInstallationsForUser: GithubInstallationsService.listInstallationsForUser,
      getInstallation: GithubInstallationsService.getInstallation,
      isAssociatedWithWorkspace: GithubInstallationsService.isAssociatedWithWorkspace,
      associateWithWorkspace: GithubInstallationsService.associateWithWorkspace,
      listInstallationRepos: (id) => getGitHubAppService().listInstallationRepos(id),
      listPullRequests: (id, owner, repo, state) => getGitHubAppService().listPullRequests(id, owner, repo, state),
      getPullRequestDiff: (id, owner, repo, n) => getGitHubAppService().getPullRequestDiff(id, owner, repo, n),
      mergePullRequest: (id, owner, repo, n, method) => getGitHubAppService().mergePullRequest(id, owner, repo, n, method),
      upsertProjectRepo: GithubProjectReposService.upsertProjectRepo,
      removeProjectRepo: GithubProjectReposService.removeProjectRepo,
      backfillInstallationAccount: async (id) => {
        const acct = await getGitHubAppService().getInstallationAccount(id);
        if (!acct.accountLogin) return null;
        await GithubInstallationsService.setInstallationAccount(id, acct);
        return acct;
      },
    });

    // User-scoped cross-server PR aggregate (Home hub "Pull Requests" page).
    app.get('/api/github/pulls', async (c) => {
      const userId = await requireAuthenticatedUser(c);
      if (!userId) return c.json({ error: 'Unauthorized' }, 401);
      const pulls = await aggregateForUser(userId, {
        listForUser: GithubProjectReposService.listForUser,
        listPullRequests: (id, owner, repo, state) => getGitHubAppService().listPullRequests(id, owner, repo, state),
      });
      return c.json({ data: pulls });
    });
  }

  return app;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Upgrade legacy model IDs to their latest equivalents
const MODEL_UPGRADES: Record<string, string> = {
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-opus-4-20250514': 'claude-opus-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
};

function resolveModel(model: string): string {
  return MODEL_UPGRADES[model] || model;
}


// ============================================================================
// Server Start Function
// ============================================================================

export function startHttpServer(port: number) {
  const app = createHttpApp();

  console.log(`[HTTP] Starting server on port ${port}`);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  return server;
}
