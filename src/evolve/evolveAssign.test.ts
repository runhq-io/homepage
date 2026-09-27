import { describe, expect, it } from 'vitest';
import { evolveAssign, evolveRoll } from './evolveAssign.js';
import source from './evolveAssign.js?raw';

/**
 * R114b: the homepage paints an arm with the SAME assignment code the SDK
 * (widget.js) runs, byte for byte. The canonical block is the platform's
 * be/src/sdk/evolve-assign.js; its test pins the same SHA-256 as this one, so
 * a copy that drifts in either repo fails loudly instead of painting one arm
 * while the SDK records another.
 *
 * Since campaigns hold LANES of one project traffic pool, the block also takes
 * the serving config's `poolSalt` and reads the run's `lane`; LANE_VECTORS
 * below is a slice of the platform's frozen lane table.
 */
const EVOLVE_ASSIGN_SHA256 = '4d2ded8dc15be8ece7e2264c2e8925fb387f218f5fed1cd986ac213680a3946f';
const BEGIN = '// ---- BEGIN runhq-evolve-assign v1 ----\n';
const END = '// ---- END runhq-evolve-assign v1 ----\n';

function block(source: string): string {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new Error('evolve-assign block markers not found');
  return source.slice(start, end + END.length);
}

/** A slice of the platform's FROZEN golden vectors (packages/protocol src/evolve/assignVectors.ts). */
const VECTOR_ARMS = [
  { variationId: 'control', weight: 1 },
  { variationId: 'potato', weight: 1 },
  { variationId: 'dragon', weight: 2 },
];
const VECTORS = [
  { subjectKey: '', epoch: 0, roll: 0.25367626478, variationId: 'dragon' },
  { subjectKey: '', epoch: 3, roll: 0.792015519924, variationId: 'potato' },
  { subjectKey: 'anon-1', epoch: 0, roll: 0.612061305437, variationId: 'dragon' },
  { subjectKey: 'anon-1000', epoch: 0, roll: 0.127517043846, variationId: 'control' },
  { subjectKey: '🥔-ポテト-🐶', epoch: 3, roll: 0.772318704287, variationId: 'potato' },
  { subjectKey: 'a'.repeat(300), epoch: 0, roll: 0.130034361966, variationId: 'control' },
];

/**
 * A slice of the platform's FROZEN lane vectors (LANE_VECTORS, same file): the
 * subject's pool roll in the project's pool and, for each lane of VECTOR_LANES,
 * the arm it is assigned, or null (outside the lane: not assigned). The four
 * `edge-*` rows lie within a millionth of 0.25 / 0.5, one either side: the
 * lane's start is inclusive and its end strict.
 */
const L_WHOLE = { start: 0, end: 1 };
const L_LOW = { start: 0, end: 0.5 };
const L_HIGH = { start: 0.5, end: 1 };
const L_QUARTER = { start: 0.25, end: 0.5 };
const LANE_VECTORS = [
  { subjectKey: '', epoch: 3, poolRoll: 0.742071260232, assigned: ['potato', null, 'potato', null] },
  { subjectKey: 'a'.repeat(300), epoch: 0, poolRoll: 0.973657891154, assigned: ['control', null, 'control', null] },
  { subjectKey: 'anon-1000', epoch: 3, poolRoll: 0.050263059558, assigned: ['dragon', 'dragon', null, null] },
  { subjectKey: '🥔-ポテト-🐶', epoch: 0, poolRoll: 0.185212763026, assigned: ['dragon', 'dragon', null, null] },
  { subjectKey: 'edge-1564883', epoch: 0, poolRoll: 0.249999181833, assigned: ['dragon', 'dragon', null, null] },
  { subjectKey: 'edge-430791', epoch: 0, poolRoll: 0.250000432599, assigned: ['potato', 'potato', null, 'potato'] },
  { subjectKey: 'edge-1001524', epoch: 0, poolRoll: 0.499999324325, assigned: ['control', 'control', null, 'control'] },
  { subjectKey: 'edge-617102', epoch: 0, poolRoll: 0.500000845408, assigned: ['control', null, 'control', null] },
] as const;
const VECTOR_LANES = [L_WHOLE, L_LOW, L_HIGH, L_QUARTER];

describe('the vendored assignment block', () => {
  it('is byte-identical to the SDK’s (pinned SHA-256)', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(block(source)));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(EVOLVE_ASSIGN_SHA256);
  });

  it('reproduces the frozen golden vectors, digit for digit', () => {
    for (const v of VECTORS) {
      expect(Number(evolveRoll('salt_v1', 'exp_potato', v.epoch, v.subjectKey).toFixed(12))).toBe(v.roll);
      const exp = { experimentId: 'exp_potato', epoch: v.epoch, salt: 'salt_v1', arms: VECTOR_ARMS };
      expect(evolveAssign(exp, v.subjectKey, 'project_v1')).toBe(v.variationId);
      expect(evolveAssign({ ...exp, arms: [...VECTOR_ARMS].reverse() }, v.subjectKey, 'project_v1')).toBe(v.variationId);
    }
  });

  it('reproduces the frozen lane vectors: the pool roll, and the arm or nothing in each lane', () => {
    for (const v of LANE_VECTORS) {
      expect(Number(evolveRoll('project_v1', 'pool', 0, v.subjectKey).toFixed(12))).toBe(v.poolRoll);
      VECTOR_LANES.forEach((lane, i) => {
        const exp = { experimentId: 'exp_potato', epoch: v.epoch, salt: 'salt_v1', lane, arms: VECTOR_ARMS };
        expect(evolveAssign(exp, v.subjectKey, 'project_v1')).toBe(v.assigned[i]);
      });
    }
  });

  it('a narrowed lane without a pool salt admits nobody; the whole pool, or no lane, needs none', () => {
    const exp = { experimentId: 'exp_potato', epoch: 0, salt: 'salt_v1', arms: VECTOR_ARMS };
    expect(evolveAssign({ ...exp, lane: L_LOW }, 'anon-1000', undefined)).toBeNull();
    expect(evolveAssign({ ...exp, lane: L_WHOLE }, 'anon-1000', undefined)).toBe(evolveAssign(exp, 'anon-1000', 'project_v1'));
    expect(evolveAssign(exp, 'anon-1000', undefined)).toBe(evolveAssign(exp, 'anon-1000', 'project_v1'));
  });

  it('assigns nothing when no arm is servable', () => {
    expect(evolveAssign({ experimentId: 'e', epoch: 0, salt: 's', arms: [{ variationId: 'a', weight: 0 }] }, 'x', 'p')).toBeNull();
  });
});
