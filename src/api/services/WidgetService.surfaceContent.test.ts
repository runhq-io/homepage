import { describe, it, expect } from 'vitest';
import { surfaceActivityContent } from './WidgetService';

describe('surfaceActivityContent', () => {
  it('surfaces content for allowlisted types', () => {
    expect(surfaceActivityContent('comment', 'hello')).toBe('hello');
    expect(surfaceActivityContent('status_change', 'started a review')).toBe('started a review');
    expect(surfaceActivityContent('agent_update', 'We reproduced the issue.')).toBe('We reproduced the issue.');
  });

  it('drops content for internal-locator types (closes the branch_pushed leak)', () => {
    expect(
      surfaceActivityContent('branch_pushed', 'Branch session/job_jmHr8Nizs9NTltDX/ticket-39093375 pushed'),
    ).toBeNull();
    expect(surfaceActivityContent('pr_linked', 'PR #12 https://github.com/x/y/pull/12')).toBeNull();
    expect(surfaceActivityContent('agent_assigned', 'assigned Codex Coder')).toBeNull();
  });

  it('returns null for null/undefined content even when allowlisted', () => {
    expect(surfaceActivityContent('comment', null)).toBeNull();
    expect(surfaceActivityContent('agent_update', undefined)).toBeNull();
  });

  it('drops content for unknown types by default', () => {
    expect(surfaceActivityContent('some_future_type', 'internal detail')).toBeNull();
  });
});
