import { describe, it, expect } from 'vitest';

import { roleMapGrantsAssignAgent, roleMapGrantsApproval } from './WidgetService';

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

/**
 * Gate for the `pending_approval` born state: an unauthorized reporter's ticket
 * only enters the approval queue when the project actually has an approver role.
 * Projects that never grant `approve_tickets` keep the legacy `pending` path.
 */
describe('roleMapGrantsApproval', () => {
  it('true when granted to any role', () => {
    expect(roleMapGrantsApproval({ staff: ['view_tickets', 'approve_tickets'] })).toBe(true);
    expect(roleMapGrantsApproval({ moderator: ['approve_tickets'] })).toBe(true);
  });

  it('false when no role grants approve_tickets', () => {
    expect(roleMapGrantsApproval({ everyone: ['view_tickets'], staff: ['assign_agent', 'preview'] })).toBe(false);
  });

  it('false for empty / null / undefined', () => {
    expect(roleMapGrantsApproval({})).toBe(false);
    expect(roleMapGrantsApproval(null)).toBe(false);
    expect(roleMapGrantsApproval(undefined)).toBe(false);
  });

  it('tolerates malformed (non-array) values', () => {
    expect(roleMapGrantsApproval({ staff: 'approve_tickets' as unknown as string[] })).toBe(false);
  });
});
