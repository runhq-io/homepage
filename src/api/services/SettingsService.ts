import { db } from '../../db/index';
import { systemSettings } from '../../db/schema';
import { eq } from 'drizzle-orm';

export interface SystemSettings {
  claudeApiKey: string;
  claudeModel: string;
  systemPrompt: string;
  serverCreationDisabled: boolean;
  serverCreationDisabledMessage: string;
}

export const DEFAULT_SERVER_CREATION_DISABLED_MESSAGE =
  'Server creation is temporarily disabled. Please try again later.';

// Default global system prompt - applies to ALL agents
export const DEFAULT_GLOBAL_SYSTEM_PROMPT = `You are an AI virtual employee. You don't just assist - you actually DO the work yourself.

When assigned a role (moderator, customer service rep, data entry clerk, etc.), you ARE that role. You take full ownership and perform the job as if you were hired for it.

You have access to a browser and terminal to perform real online work autonomously.`;

// Read defaults lazily — ESM hoists imports before dotenv.config() runs,
// so process.env is empty at module-load time.
function getDefaults(): SystemSettings {
  return {
    claudeApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: 'claude-sonnet-4-6',
    systemPrompt: DEFAULT_GLOBAL_SYSTEM_PROMPT,
    serverCreationDisabled: false,
    serverCreationDisabledMessage: DEFAULT_SERVER_CREATION_DISABLED_MESSAGE,
  };
}

let cachedSettings: SystemSettings | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minute cache

export async function getSettings(): Promise<SystemSettings> {
  // Return cached settings if still valid
  if (cachedSettings && Date.now() - cacheTime < CACHE_TTL) {
    return cachedSettings;
  }

  try {
    const rows = await db.select().from(systemSettings);
    const settingsMap = new Map(rows.map((r) => [r.key, r.value]));

    const defaults = getDefaults();
    cachedSettings = {
      claudeApiKey: settingsMap.get('claude_api_key') || defaults.claudeApiKey,
      claudeModel: settingsMap.get('claude_model') || defaults.claudeModel,
      systemPrompt: settingsMap.get('system_prompt') || defaults.systemPrompt,
      serverCreationDisabled: settingsMap.get('server_creation_disabled') === 'true',
      serverCreationDisabledMessage:
        settingsMap.get('server_creation_disabled_message') || defaults.serverCreationDisabledMessage,
    };
    cacheTime = Date.now();

    return cachedSettings;
  } catch (error) {
    console.error('[SettingsService] Error loading settings from database:', error);
    return getDefaults();
  }
}

export function invalidateSettingsCache(): void {
  cachedSettings = null;
  cacheTime = 0;
}
