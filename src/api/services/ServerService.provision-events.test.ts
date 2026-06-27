import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index';
import { servers, serverProvisionEvents, users } from '../../db/schema';
import { recordProvisionEvent, getProvisionEvents } from './ServerService';

describe('provision events', () => {
  let serverId: string;

  beforeEach(async () => {
    const [u] = await db.insert(users).values({
      email: `prov-${randomUUID()}@test.local`,
    }).returning();
    serverId = `ws_${randomUUID().slice(0, 8)}`;
    await db.insert(servers).values({
      id: serverId,
      name: 'prov test',
      ownerId: u.id,
      status: 'provisioning',
    });
  });

  it('appends ordered events and updates servers.provision_step', async () => {
    await recordProvisionEvent(serverId, 'queued', 'Queued for provisioning');
    await recordProvisionEvent(serverId, 'creating_machine', 'Creating machine');

    const events = await getProvisionEvents(serverId);
    expect(events.map(e => e.step)).toEqual(['queued', 'creating_machine']);
    expect(events[1].message).toBe('Creating machine');

    const [row] = await db.select().from(servers).where(eq(servers.id, serverId));
    expect(row.provisionStep).toBe('creating_machine');
  });

  it('getProvisionEvents returns [] for a server with no events', async () => {
    expect(await getProvisionEvents(serverId)).toEqual([]);
  });
});
