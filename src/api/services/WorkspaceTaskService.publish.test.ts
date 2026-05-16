import { describe, it, expect } from 'vitest';
import { resolveCreateIsPublished, resolvePublishVisibility } from './WorkspaceTaskService';

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

describe('resolvePublishVisibility', () => {
  it('promotes to public when publishing a private task', () => {
    expect(resolvePublishVisibility({ isPublished: true }, 'private')).toBe('public');
  });
  it('keeps incoming public visibility', () => {
    expect(resolvePublishVisibility({ isPublished: true, visibility: 'public' }, 'private')).toBe('public');
  });
  it('does not change visibility when not publishing', () => {
    expect(resolvePublishVisibility({ isPublished: false }, 'private')).toBeUndefined();
    expect(resolvePublishVisibility({}, 'private')).toBeUndefined();
  });
  it('is a no-op when publishing a task that is already public', () => {
    expect(resolvePublishVisibility({ isPublished: true }, 'public')).toBeUndefined();
  });
  it('does not override an explicit visibility in the same update', () => {
    expect(resolvePublishVisibility({ isPublished: true, visibility: 'private' }, 'public')).toBe('private');
  });
});
