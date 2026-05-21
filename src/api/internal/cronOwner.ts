import { z } from 'zod';

/**
 * Discriminator for `workflow_cron_schedules` rows. Each schedule is owned by
 * exactly one entity: either an agent (template cron — fires create new jobs)
 * or a job (job-scoped cron — fires re-run the existing job). The Postgres
 * CHECK `num_nonnulls(agent_id, job_id) = 1` enforces this at the DB layer;
 * this schema mirrors the same invariant in the wire protocol between the
 * workspace server's cron-sync client and /be.
 */
export const cronOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }),
  z.object({ kind: z.literal('job'),   jobId:   z.string().min(1) }),
]);

export type CronOwner = z.infer<typeof cronOwnerSchema>;
