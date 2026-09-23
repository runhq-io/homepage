/*
 * VENDORED from the RunHQ platform repo: be/src/sdk/evolve-assign.js.
 * The block between the BEGIN/END lines is byte-identical to the one inside
 * the SDK (be/public/widget.js); evolveAssign.test.ts pins its SHA-256, the
 * same constant the platform's test pins. Never edit it here — change the
 * platform's copy, then copy the block over and update both constants.
 */
// ---- BEGIN runhq-evolve-assign v1 ----
// Evolve variation assignment: which arm a visitor sees. ES5, dependency-free,
// no exports, so the same bytes run inside widget.js's IIFE and in any page
// that paints an arm before the SDK has loaded (the runhq.io homepage, R114).
//
// This block is copied BYTE FOR BYTE between the BEGIN/END lines into:
//   - be/public/widget.js
//   - the homepage repo's src/evolve/evolveAssign.js
// Tests in both repos pin its SHA-256 (EVOLVE_ASSIGN_SHA256), and the copies
// in packages/protocol (assign.ts) are pinned to the same frozen golden
// vectors (assignVectors.ts). Editing it re-buckets every visitor in every
// running experiment: that is an epoch bump for the whole fleet, not a refactor.

/** FNV-1a (32-bit), mixing both bytes of each UTF-16 unit so non-ASCII keys don't alias. */
function evolveHash(value) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < value.length; i++) {
    var unit = value.charCodeAt(i);
    hash ^= unit & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (unit >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** murmur3 fmix32 — FNV alone leaves structure in the low bits that sequential ids expose. */
function evolveAvalanche(input) {
  var hash = input;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The subject's position in [0, 1). */
function evolveRoll(salt, experimentId, epoch, subjectKey) {
  return evolveAvalanche(evolveHash(salt + ":" + experimentId + ":" + epoch + ":" + subjectKey)) / 0x100000000;
}

/**
 * Which arm this subject sees, or null when nothing is servable.
 * `experiment` is { experimentId, epoch, salt, arms: [{ variationId, weight }] };
 * the subject key is the SDK's anon id (`rw_anon_id`).
 */
function evolveAssign(experiment, subjectKey) {
  var servable = [];
  for (var i = 0; i < experiment.arms.length; i++) {
    var arm = experiment.arms[i];
    if (isFinite(arm.weight) && arm.weight > 0) servable.push(arm);
  }
  if (!servable.length) return null;
  servable.sort(function (a, b) {
    return a.variationId < b.variationId ? -1 : a.variationId > b.variationId ? 1 : 0;
  });
  var total = 0;
  for (var j = 0; j < servable.length; j++) total += servable[j].weight;
  var cursor = evolveRoll(experiment.salt, experiment.experimentId, experiment.epoch, subjectKey) * total;
  for (var k = 0; k < servable.length; k++) {
    cursor -= servable[k].weight;
    if (cursor < 0) return servable[k].variationId;
  }
  return servable[servable.length - 1].variationId;
}
// ---- END runhq-evolve-assign v1 ----

export { evolveAssign, evolveRoll };
