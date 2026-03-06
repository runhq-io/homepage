/**
 * HTTP Server for API endpoints
 *
 * Provides REST API endpoints for:
 * - Claude API proxy (adds API key, tracks usage)
 * - Checkpoint storage
 * - Usage tracking
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createToken, verifyToken, extractUserIdFromToken } from './auth/jwt';
import { getSettings } from './services/SettingsService';
import * as UsageService from './services/UsageService';
import * as StripeService from './services/StripeService';
import * as InviteService from './services/InviteService';
import * as TelemetryService from './services/TelemetryService';
import * as ServerService from './services/ServerService';
import * as ServerSessionService from './services/ServerSessionService';
import * as PublicPortService from './services/PublicPortService';
import * as MachineUsageService from './services/MachineUsageService';
import { getProvider, hasProvider, getDefaultProviderId, isAnyProviderConfigured } from './services/providers/registry';
import type { ProviderId } from './services/providers/types';
import type { Screenshot, TokenUsage } from '@fishtank/server-protocol';
import type { PlanId } from '../db/schema';
import { db } from '../db/index';
import { users, deviceCodes, servers, serverTemplates } from '../db/schema';
import { eq, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

type BuildInfo = {
  gitSha?: string;
  ref?: string;
  runNumber?: number;
  builtAt?: string;
};

let cachedBuildInfo: BuildInfo | null | undefined;

// Latest server version — set at runtime by deploy script via POST /api/admin/set-server-version
let latestServerVersion: string | null = null;

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

  // Enable CORS for all routes
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
  }));

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
      const creditCheck = await UsageService.checkCreditBalance(token);
      if (!creditCheck.allowed) {
        const errorResponse: Record<string, unknown> = {
          error: creditCheck.reason === 'insufficient_credits'
            ? 'Insufficient credits - please add more credits to continue'
            : creditCheck.reason === 'past_due'
              ? 'Payment past due - please update your payment method'
              : 'Subscription required',
          code: 'INSUFFICIENT_CREDITS',
          balanceCents: creditCheck.balanceCents,
          plan: creditCheck.plan,
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
      const model = body.config?.model || settings.claudeModel || 'claude-sonnet-4-20250514';
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
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      const costCents = calculateCost(model, inputTokens, outputTokens);

      const tokenUsage: TokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens,
        model,
        costCents,
      };

      // Track usage (async, don't wait)
      UsageService.trackTokenUsage(token, tokenUsage).catch(err => {
        console.error('[HttpServer] Failed to track usage:', err);
      });

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
        const creditCheck = await UsageService.checkCreditBalance(token);
        if (!creditCheck.allowed) {
          const errorResponse: Record<string, unknown> = {
            error: creditCheck.reason === 'insufficient_credits'
              ? 'Insufficient credits - please add more credits to continue'
              : creditCheck.reason === 'past_due'
                ? 'Payment past due - please update your payment method'
                : 'Subscription required',
            code: 'INSUFFICIENT_CREDITS',
            balanceCents: creditCheck.balanceCents,
            plan: creditCheck.plan,
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

      const model = body.model || settings.claudeModel || 'claude-sonnet-4-20250514';
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


      // Calculate and track usage
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;

      // Log cache stats to verify caching is working
      const cacheCreation = (response.usage as any)?.cache_creation_input_tokens || 0;
      const cacheRead = (response.usage as any)?.cache_read_input_tokens || 0;
      if (cacheCreation > 0 || cacheRead > 0) {
        console.log(`[HttpServer] CACHE: write=${cacheCreation}, read=${cacheRead} (${cacheRead > 0 ? 'HIT' : 'MISS'})`);
      } else {
        console.log(`[HttpServer] CACHE: no cache activity (tokens: ${inputTokens} in, ${outputTokens} out)`);
      }

      // Count web searches (billed at $0.01 per search = 1 cent)
      const webSearchCount = response.content.filter(
        (block) => block.type === 'server_tool_use' && (block as { name?: string }).name === 'web_search'
      ).length;
      const webSearchCostCents = webSearchCount * 1; // $0.01 per search

      const tokenCostCents = calculateCost(model, inputTokens, outputTokens);
      const costCents = tokenCostCents + webSearchCostCents;

      if (webSearchCount > 0) {
        console.log(`[HttpServer] Web searches: ${webSearchCount}, search cost: ${webSearchCostCents}¢, token cost: ${tokenCostCents}¢`);
      }

      const tokenUsage: TokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model,
        costCents,
      };

      // Track usage and get updated balance
      let newBalanceCents = 0;
      try {
        const trackResult = await UsageService.trackUsage(token, tokenUsage);
        newBalanceCents = trackResult.newBalanceCents;
      } catch (err) {
        console.error('[HttpServer] Failed to track usage:', err);
      }

      // Return response with cost info for UI display
      return c.json({
        content: response.content,
        stop_reason: response.stop_reason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
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
      const usage = await UsageService.getUsage(token);

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
      const body = await c.req.json() as { version?: string };
      if (!body.version || typeof body.version !== 'string') {
        return c.json({ error: 'Missing version' }, 400);
      }
      latestServerVersion = body.version;
      console.log(`[HttpServer] Latest server version set to: ${latestServerVersion}`);
      return c.json({ success: true, version: latestServerVersion });
    } catch (error) {
      console.error('[HttpServer] Set server version error:', error);
      return c.json({ error: 'Failed to set server version' }, 500);
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

      // Fetch live machine states from each provider for all servers with machines
      // This allows the UI to show accurate running/stopped status for each server
      let machineStateMap: Map<string, string> = new Map();
      const serversWithMachines = servers.filter(w => w.machineId);
      if (serversWithMachines.length > 0) {
        // Group servers by provider so we call listMachines() once per provider
        const providerIds = new Set<string>();
        for (const s of serversWithMachines) {
          providerIds.add(s.provider || 'fly');
        }
        for (const pid of providerIds) {
          try {
            const provider = getProvider(pid as ProviderId);
            const machines = await provider.listMachines();
            for (const machine of machines) {
              machineStateMap.set(machine.id, machine.state);
            }
          } catch (err) {
            // Don't fail the whole request if we can't get machine states
            console.warn(`[HttpServer] Could not fetch ${pid} machine states:`, err);
          }
        }
      }

      // Transform servers: don't expose hash, but indicate if token exists
      // For remote servers, use the correct provider-specific URL
      const data = servers.map((w) => {
        let serverUrl = w.serverUrl;
        if (w.machineId) {
          const provider = getProvider((w.provider || 'fly') as ProviderId);
          const routingUrl = provider.getRoutingInfo(w.machineId).serverUrl;
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

  // Create a new server
  app.post('/api/servers', async (c) => {
    try {
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
      if (requestedProvider && !hasProvider(requestedProvider)) {
        return c.json({ error: `Provider '${requestedProvider}' is not available` }, 400);
      }

      // Validate tier (accepts both generic TierId names and legacy Fly tier names)
      const validTiers = ['micro', 'small', 'medium', 'large', 'xlarge', 'xxlarge', 'shared-cpu-1x', 'shared-cpu-2x', 'performance-cpu-2x', 'performance-cpu-4x'];
      if (tier && !validTiers.includes(tier)) {
        return c.json({ error: `Invalid tier. Must be one of: micro, small, medium, large, xlarge, xxlarge` }, 400);
      }

      // Enforce server limit per plan (admins bypass)
      const userIsAdmin = await UsageService.isAdmin(userId);
      if (!userIsAdmin) {
        const subscription = await UsageService.getOrCreateSubscription(userId);
        const planConfig = UsageService.PLAN_CONFIG[subscription.planId as keyof typeof UsageService.PLAN_CONFIG] || UsageService.PLAN_CONFIG.free;
        const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(servers).where(eq(servers.ownerId, userId));
        const currentCount = Number(countResult?.count ?? 0);
        if (currentCount >= planConfig.maxServers) {
          return c.json({
            error: 'Server limit reached',
            maxServers: planConfig.maxServers,
            currentCount,
          }, 403);
        }
      }

      // Generate a server ID
      const serverId = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await ServerService.createServer(userId, {
        id: serverId,
        name,
        deploymentType: deploymentType || 'local',
        region: region || 'ash',
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
      const hasAccess = await ServerService.canAccessServer(serverId, userId);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }

      const server = await ServerService.getServer(serverId);
      if (!server) {
        return c.json({ error: 'Server not found' }, 404);
      }

      // Return server with server info (don't expose hash)
      let serverUrl = server.serverUrl;
      if (server.machineId) {
        const provider = getProvider((server.provider || 'fly') as ProviderId);
        const routingUrl = provider.getRoutingInfo(server.machineId).serverUrl;
        if (routingUrl) serverUrl = routingUrl;
      }
      return c.json({
        server: {
          id: server.id,
          name: server.name,
          ownerId: server.ownerId,
          deploymentType: server.deploymentType,
          serverUrl,
          status: server.status,
          lastSeen: server.lastSeen,
          machineId: server.machineId,
          region: server.region,
          provider: server.provider || 'fly',
          tier: server.tier || 'shared-cpu-1x',
          iconUrl: server.iconUrl || null,
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
      const hasAccess = await ServerService.canAccessServer(serverId, userId);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }

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

      // Validate iconUrl if provided
      if (iconUrl !== undefined && iconUrl !== null) {
        if (typeof iconUrl !== 'string' || !iconUrl.startsWith('data:image/')) {
          return c.json({ error: 'iconUrl must be a data:image/ URL or null' }, 400);
        }
        if (iconUrl.length > 256 * 1024) {
          return c.json({ error: 'iconUrl exceeds maximum size of 256KB' }, 400);
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
      const { email, role, serverName } = body;

      if (!email) {
        return c.json({ error: 'Email is required' }, 400);
      }

      // Ensure server exists in cloud (create if not)
      await ServerService.ensureServer(serverId, userId, serverName || 'Untitled Server');

      const invite = await ServerService.createInvite(serverId, userId, email, role || 'member');
      return c.json({ success: true, invite });
    } catch (error) {
      console.error('[HttpServer] Invite member error:', error);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Remove member from server
  app.delete('/api/servers/:serverId/members/:memberId', async (c) => {
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
      const memberId = c.req.param('memberId');

      const success = await ServerService.removeMember(serverId, userId, memberId);
      return c.json({ success });
    } catch (error) {
      console.error('[HttpServer] Remove member error:', error);
      return c.json({ error: 'Failed to remove member' }, 500);
    }
  });

  // Update member role
  app.patch('/api/servers/:serverId/members/:memberId', async (c) => {
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
      const memberId = c.req.param('memberId');
      const body = await c.req.json();
      const { role } = body;

      if (!role || !['admin', 'member', 'viewer'].includes(role)) {
        return c.json({ error: 'Invalid role' }, 400);
      }

      const success = await ServerService.updateMemberRole(serverId, userId, memberId, role);
      if (!success) {
        return c.json({ error: 'Failed to update member role' }, 403);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Update member role error:', error);
      return c.json({ error: 'Failed to update member role' }, 500);
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
      const { userId: targetUserId, reason } = body;

      if (!targetUserId) {
        return c.json({ error: 'userId is required' }, 400);
      }

      const success = await ServerService.banMember(serverId, userId, targetUserId, reason);
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
      const body = await c.req.json() as { expiresIn?: number; maxUses?: number };
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
      const linkId = c.req.param('linkId');
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
      const { serverToken, serverUrl } = body;

      if (!serverToken || typeof serverToken !== 'string') {
        return c.json({ error: 'serverToken is required' }, 400);
      }
      if (!serverUrl || typeof serverUrl !== 'string') {
        return c.json({ error: 'serverUrl is required' }, 400);
      }

      const result = await ServerService.registerServer(serverToken, serverUrl);

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
      const { serverToken } = body;

      if (!serverToken || typeof serverToken !== 'string') {
        return c.json({ error: 'serverToken is required' }, 400);
      }

      const success = await ServerService.updateServerHeartbeat(serverToken);

      if (!success) {
        return c.json({ error: 'Invalid server token' }, 401);
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[HttpServer] Server heartbeat error:', error);
      return c.json({ error: 'Failed to update heartbeat' }, 500);
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
      const hasAccess = await ServerService.canAccessServer(serverId, userId);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }

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
      const hasAccess = await ServerService.canAccessServer(serverId, userId);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }

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
        const routing = provider.getRoutingInfo(server.machineId);
        const serverSessionToken = await ServerSessionService.generateServerSessionToken(userId, serverId, 3600, sessionTokenOpts);
        return c.json({
          success: true,
          serverSessionToken,
          machineId: server.machineId,
          serverUrl: routing.serverUrl || server.serverUrl,
          expiresIn: 3600,
          serverName: server.name,
          serverStatus: server.status,
          deploymentType: server.deploymentType,
          latestServerVersion,
        });
      }

      // For remote servers, ensure the machine is awake and server is ready
      let needsRefetch = false;
      if (server.deploymentType === 'remote' && isAnyProviderConfigured()) {
        // If server is still provisioning (e.g. during region change), don't try to connect yet
        if (server.status === 'provisioning') {
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
            // If wake failed due to destroyed machine, try to reprovision
            if (wakeResult.error?.includes('destroyed') || wakeResult.error?.includes('not found')) {
              // Gate reprovisioning behind payment method check
              const subscription = await UsageService.getOrCreateSubscription(userId);
              if (!subscription.stripeCustomerId) {
                console.log(`[HttpServer] No payment method for user ${userId}, blocking reprovision of server ${serverId}`);
                return c.json({ error: 'Payment method required before provisioning', needsPayment: true }, 402);
              }
              console.log(`[HttpServer] Machine was destroyed, starting background reprovision...`);
              await ServerService.setServerStatus(serverId, 'provisioning');
              ServerService.reprovisionRemoteServer(serverId, userId).catch(err => {
                console.error(`[HttpServer] Background reprovision failed for ${serverId}:`, err);
              });
              return c.json({ error: 'Server is provisioning. Please try again shortly.', serverName: server.name }, 503);
            } else {
              console.error(`[HttpServer] Failed to wake machine: ${wakeResult.error}`);
              return c.json({ error: wakeResult.error || 'Failed to wake server', serverName: server.name }, 503);
            }
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
        const routingUrl = provider.getRoutingInfo(latestServer.machineId).serverUrl;
        if (routingUrl) serverUrl = routingUrl;
      }

      if (latestServer.deploymentType === 'remote' && !latestServer.machineId && isAnyProviderConfigured()) {
        return c.json({ error: 'Server machine is not ready yet. Please try again shortly.', serverName: latestServer.name }, 503);
      }

      if (!serverUrl) {
        return c.json({ error: 'Server server URL is not available yet. Please try again shortly.', serverName: latestServer.name }, 503);
      }

      let routingMachineId = latestServer.machineId || null;

      // Verify machine identity to detect stale routing.
      // If mismatch, return error — the correct fix is reprovisioning, not scanning all machines.
      if (latestServer.deploymentType === 'remote' && routingMachineId) {
        try {
          const provider = getProvider((latestServer.provider || 'fly') as ProviderId);
          const routing = provider.getRoutingInfo(routingMachineId);
          const routingHeaders: Record<string, string> = { 'cache-control': 'no-cache' };
          // Only add provider-specific routing headers when required (e.g. Fly's fly-force-instance-id)
          if (routing.requiresRoutingHeaders && routing.routingToken) {
            routingHeaders['fly-force-instance-id'] = routing.routingToken;
          }
          const infoParams = routing.requiresRoutingHeaders && routing.routingToken
            ? `?fly_instance_id=${encodeURIComponent(routing.routingToken)}`
            : '';
          const infoUrl = `${serverUrl}/info${infoParams}`;
          const infoRes = await fetch(infoUrl, {
            method: 'GET',
            headers: routingHeaders,
          });

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
          }
        } catch {
          // Machine unreachable — let the request continue, the proxy will handle it
        }
      }

      // Generate a server-scoped session token (1 hour validity)
      const serverSessionToken = await ServerSessionService.generateServerSessionToken(userId, serverId, 3600, sessionTokenOpts);

      return c.json({
        success: true,
        serverSessionToken,
        machineId: routingMachineId,
        serverUrl,
        expiresIn: 3600, // seconds
        serverName: latestServer.name,
        serverStatus: latestServer.status,
        deploymentType: latestServer.deploymentType,
        latestServerVersion,
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

  return app;
}

// ============================================================================
// Helper Functions
// ============================================================================

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Prices per 1M tokens in dollars
  const pricing: Record<string, { input: number; output: number }> = {
    'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
    'claude-3-5-sonnet-latest': { input: 3, output: 15 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
    'claude-3-5-haiku-latest': { input: 0.8, output: 4 },
    'claude-3-opus-20240229': { input: 15, output: 75 },
    'claude-3-opus-latest': { input: 15, output: 75 },
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'claude-opus-4-20250514': { input: 15, output: 75 },
  };

  const price = pricing[model] || { input: 3, output: 15 };
  const inputCostCents = (inputTokens / 1_000_000) * price.input * 100;
  const outputCostCents = (outputTokens / 1_000_000) * price.output * 100;

  return Math.round((inputCostCents + outputCostCents) * 1000) / 1000;
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
