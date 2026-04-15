// ============================================================================
// Channel Types for External Messaging Integration
// ============================================================================

/**
 * Supported channel types
 */
export type ChannelType = 'telegram' | 'twilio_sms' | 'twilio_whatsapp' | 'webhook';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
}

/**
 * Base channel configuration
 */
export interface BaseChannelConfig {
  enabled: boolean;
  rateLimits?: {
    perUser: RateLimitConfig;
    global: RateLimitConfig;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Telegram channel configuration
 */
export interface TelegramChannelConfig extends BaseChannelConfig {
  botTokenVaultKey: string;     // Vault key for encrypted bot token
  webhookSecret: string;        // X-Telegram-Bot-Api-Secret-Token
  allowedUserIds?: string[];    // Whitelist (empty = allow all)
  maxMessageAgeSeconds: number; // Reject messages older than this (default: 120)
}

/**
 * Twilio channel configuration (SMS + WhatsApp)
 */
export interface TwilioChannelConfig extends BaseChannelConfig {
  accountSidVaultKey: string;   // Vault key for account SID
  authTokenVaultKey: string;    // Vault key for auth token
  phoneNumber: string;          // Twilio phone number
  enableSms: boolean;
  enableWhatsapp: boolean;
}

/**
 * Generic webhook channel configuration
 */
export interface WebhookChannelConfig extends BaseChannelConfig {
  incomingSecret: string;       // HMAC-SHA256 secret for validation
  outgoingUrl?: string;         // Where to POST responses
  outgoingSecret?: string;      // HMAC secret for outgoing requests
}

/**
 * Vapi voice AI configuration
 */
export interface VapiConfig {
  enabled: boolean;
  // Vapi assistant is configured in Vapi dashboard
  // We just provide the LLM endpoint URL
}

/**
 * Agent's complete channel configuration
 */
export interface AgentChannels {
  telegram?: TelegramChannelConfig;
  twilio?: TwilioChannelConfig;
  webhook?: WebhookChannelConfig;
  vapi?: VapiConfig;
}

/**
 * Stored channel message
 */
export interface ChannelMessage {
  id: string;
  agentId: string;
  conversationId: string;
  direction: 'incoming' | 'outgoing';
  channelType: ChannelType | 'vapi';
  senderId?: string;
  senderName?: string;
  content: string;
  contentType: 'text' | 'voice';
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Channel status for monitoring
 */
export interface ChannelStatus {
  type: ChannelType | 'vapi';
  enabled: boolean;
  connected: boolean;
  webhookUrl?: string;
  lastActivity?: string;
  error?: string;
  messageCount?: number;
  rateLimitStatus?: {
    remaining: number;
    resetAt: string;
  };
}

/**
 * Incoming message from any channel (normalized)
 */
export interface IncomingChannelMessage {
  channelType: ChannelType | 'vapi';
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  contentType: 'text' | 'voice';
  metadata?: Record<string, unknown>;
  timestamp: string;
  // For idempotency
  externalMessageId?: string;
}

/**
 * Result of rate limit check
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
  retryAfterMs?: number;
}

/**
 * Channel health check response
 */
export interface ChannelHealthResponse {
  channels: ChannelStatus[];
  totalMessages24h: number;
  errorRate24h: number;
}
