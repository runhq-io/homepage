/**
 * Database Seed Script
 *
 * Seeds the database with the platform's default agent.
 * Should be called on server startup.
 */

import { db } from './index';
import { agents, agentVersions } from './schema';
import { eq } from 'drizzle-orm';
// These prompts were removed from the protocol package during rename; inline stubs for seed
const DEFAULT_WORKER_PROMPT = 'You are a helpful assistant.';
const COMMANDER_SYSTEM_PROMPT = 'You are a commander agent that coordinates tasks.';
import { seedPlans } from '../api/services/UsageService';

// Fixed UUIDs for system personas (deterministic across environments)
const SYSTEM_DEFAULT_AGENT_ID = '00000000-0000-0000-0000-000000000001';
const SYSTEM_COMMANDER_AGENT_ID = '00000000-0000-0000-0000-000000000002';

/**
 * Ensure the Worker persona exists
 * This is the default persona for regular workers
 */
export async function seedWorkerPersona(): Promise<void> {
  try {
    // Check if already exists
    const existing = await db
      .select()
      .from(agents)
      .where(eq(agents.id, SYSTEM_DEFAULT_AGENT_ID))
      .limit(1);

    if (existing[0]) {
      console.log('[Seed] Worker persona already exists');
      return;
    }

    // Create the Worker persona (tool-based, no graph)
    const result = await db
      .insert(agents)
      .values({
        id: SYSTEM_DEFAULT_AGENT_ID,
        name: 'Worker',
        description: 'A versatile worker that browses the web, fills forms, and completes tasks autonomously.',
        systemPrompt: DEFAULT_WORKER_PROMPT,
        isPublic: true,
        isSystemDefault: true,
        ownerId: null, // No owner - platform-owned
        createdById: null,
        graphDefinition: null, // No graph - tool-based
        version: 1,
      })
      .returning();

    if (result[0]) {
      // Create initial version snapshot
      await db.insert(agentVersions).values({
        agentId: SYSTEM_DEFAULT_AGENT_ID,
        versionNumber: 1,
        graphDefinition: null,
        systemPrompt: result[0].systemPrompt,
        createdById: null,
        reason: 'initial',
        notes: 'Initial Worker persona',
      });

      console.log('[Seed] Created Worker persona');
    }
  } catch (error) {
    console.error('[Seed] Failed to seed Worker persona:', error);
    // Don't throw - allow server to continue starting
  }
}

/**
 * Ensure the Commander persona exists
 * This is the persona for the Townhall - orchestrates workers
 */
export async function seedCommanderPersona(): Promise<void> {
  try {
    // Check if already exists
    const existing = await db
      .select()
      .from(agents)
      .where(eq(agents.id, SYSTEM_COMMANDER_AGENT_ID))
      .limit(1);

    if (existing[0]) {
      console.log('[Seed] Commander persona already exists');
      return;
    }

    // Create the Commander persona
    const result = await db
      .insert(agents)
      .values({
        id: SYSTEM_COMMANDER_AGENT_ID,
        name: 'Commander',
        description: 'Strategic coordinator for the Townhall. Plans projects, delegates tasks to workers, and monitors progress.',
        systemPrompt: COMMANDER_SYSTEM_PROMPT,
        isPublic: true,
        isSystemDefault: true,
        ownerId: null, // No owner - platform-owned
        createdById: null,
        graphDefinition: null, // No graph - tool-based
        version: 1,
      })
      .returning();

    if (result[0]) {
      // Create initial version snapshot
      await db.insert(agentVersions).values({
        agentId: SYSTEM_COMMANDER_AGENT_ID,
        versionNumber: 1,
        graphDefinition: null,
        systemPrompt: result[0].systemPrompt,
        createdById: null,
        reason: 'initial',
        notes: 'Initial Commander persona',
      });

      console.log('[Seed] Created Commander persona');
    }
  } catch (error) {
    console.error('[Seed] Failed to seed Commander persona:', error);
    // Don't throw - allow server to continue starting
  }
}

/**
 * @deprecated Use seedWorkerPersona and seedCommanderPersona
 */
export const seedDefaultAgent = seedWorkerPersona;

/**
 * Run all seed functions
 */
export async function runSeeds(): Promise<void> {
  console.log('[Seed] Running database seeds...');
  await seedWorkerPersona();
  await seedCommanderPersona();
  await seedPlans();
  console.log('[Seed] Database seeds complete');
}

// Export persona IDs for reference
export { SYSTEM_DEFAULT_AGENT_ID, SYSTEM_COMMANDER_AGENT_ID };
