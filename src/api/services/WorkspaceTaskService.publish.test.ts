import { describe, it, expect } from 'vitest';
import { resolveCreateIsPublished } from './WorkspaceTaskService';

describe('resolveCreateIsPublished', () => {
  it('defaults workspace-sourced tasks to published', () => {
    expect(resolveCreateIsPublished({ sourceType: 'workspace' })).toBe(true);
  });
  it('defaults absent source (treated as workspace) to published', () => {
    expect(resolveCreateIsPublished({})).toBe(true);
  });
  it('defaults widget-sourced tasks to unpublished', () => {
    expect(resolveCreateIsPublished({ sourceType: 'widget' })).toBe(false);
  });
  it('honors an explicit isPublished override', () => {
    expect(resolveCreateIsPublished({ sourceType: 'widget', isPublished: true })).toBe(true);
    expect(resolveCreateIsPublished({ sourceType: 'workspace', isPublished: false })).toBe(false);
  });
});
