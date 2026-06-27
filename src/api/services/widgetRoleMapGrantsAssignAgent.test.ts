import { describe, it, expect } from 'vitest';

import { roleMapGrantsAssignAgent } from './WidgetService';

/**
 * The legacy `widget_agent_assignment_enabled` column must stay equal to this
 * predicate — it is what the auto-assign orchestrator and the creation-time
 * injection guard gate on, while the new Permissions UI only edits the role map.
 */
describe('roleMapGrantsAssignAgent', () => {
  it('true when granted to the everyone (*) role', () => {
    expect(roleMapGrantsAssignAgent({ '*': ['assign_agent', 'live_coder', 'attach_image'] })).toBe(true);
  });

  it('true when granted to a named role', () => {
    expect(roleMapGrantsAssignAgent({ staff: ['live_coder', 'assign_agent'] })).toBe(true);
  });

  it('false when assign_agent is granted to no role', () => {
    expect(roleMapGrantsAssignAgent({ '*': ['attach_image'], staff: ['live_coder'] })).toBe(false);
  });

  it('false for an empty map', () => {
    expect(roleMapGrantsAssignAgent({})).toBe(false);
  });

  it('false for null / undefined', () => {
    expect(roleMapGrantsAssignAgent(null)).toBe(false);
    expect(roleMapGrantsAssignAgent(undefined)).toBe(false);
  });

  it('tolerates malformed (non-array) values', () => {
    expect(roleMapGrantsAssignAgent({ '*': 'assign_agent' as unknown as string[] })).toBe(false);
  });
});
