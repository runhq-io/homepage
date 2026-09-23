import { describe, expect, it } from 'vitest';
import { evolveAssign, evolveRoll } from './evolveAssign.js';
import source from './evolveAssign.js?raw';

/**
 * R114b: the homepage paints an arm with the SAME assignment code the SDK
 * (widget.js) runs, byte for byte. The canonical block is the platform's
 * be/src/sdk/evolve-assign.js; its test pins the same SHA-256 as this one, so
 * a copy that drifts in either repo fails loudly instead of painting one arm
 * while the SDK records another.
 */
const EVOLVE_ASSIGN_SHA256 = '4f3aee0c89e94e129f8823445dac29e4bf5d6e948c598316bcfb61ec88c96562';
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
      expect(evolveAssign(exp, v.subjectKey)).toBe(v.variationId);
      expect(evolveAssign({ ...exp, arms: [...VECTOR_ARMS].reverse() }, v.subjectKey)).toBe(v.variationId);
    }
  });

  it('assigns nothing when no arm is servable', () => {
    expect(evolveAssign({ experimentId: 'e', epoch: 0, salt: 's', arms: [{ variationId: 'a', weight: 0 }] }, 'x')).toBeNull();
  });
});
