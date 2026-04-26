import { describe, it, expect } from 'vitest';
import { fallbackDisplayName } from './WidgetService';

describe('fallbackDisplayName', () => {
  it('returns "Anonymous (xxxxxx)" with a 6-char hex suffix', () => {
    const label = fallbackDisplayName('external-user-1');
    expect(label).toMatch(/^Anonymous \([0-9a-f]{6}\)$/);
  });

  it('is deterministic — the same externalUserId yields the same label', () => {
    expect(fallbackDisplayName('sub-stable')).toBe(fallbackDisplayName('sub-stable'));
  });

  it('produces different labels for different externalUserIds', () => {
    expect(fallbackDisplayName('a')).not.toBe(fallbackDisplayName('b'));
  });

  it('handles empty externalUserId without throwing (defensive)', () => {
    // The caller guards against empty sub today, but the helper should still be total.
    expect(fallbackDisplayName('')).toMatch(/^Anonymous \([0-9a-f]{6}\)$/);
  });
});
