import { describe, it, expect } from 'vitest';
import { extractWidgetMetadata } from './WidgetService';

describe('extractWidgetMetadata', () => {
  it('keeps custom identifying claims', () => {
    const md = extractWidgetMetadata(
      { sub: 'u1', name: 'Ada', email: 'a@co.com', company: 'Acme', plan: 'pro', seats: 12 } as never,
      'runhq_roles',
    );
    expect(md).toEqual({ company: 'Acme', plan: 'pro', seats: 12 });
  });

  it('strips reserved + security claims', () => {
    const md = extractWidgetMetadata(
      { sub: 'u1', name: 'Ada', email: 'a@co.com', fp: 'x', type: 'widget_user',
        iat: 1, exp: 2, nbf: 0, iss: 'me', aud: 'you', jti: 'j', company: 'Acme' } as never,
      'runhq_roles',
    );
    expect(md).toEqual({ company: 'Acme' });
  });

  it('strips the configured roles claim and the default runhq_roles claim', () => {
    const md = extractWidgetMetadata(
      { sub: 'u1', org_roles: ['admin'], runhq_roles: ['staff'], company: 'Acme' } as never,
      'org_roles',
    );
    expect(md).toEqual({ company: 'Acme' });
  });

  it('returns null when there is nothing extra to store', () => {
    expect(extractWidgetMetadata({ sub: 'u1', name: 'Ada', email: 'a@co.com' } as never, 'runhq_roles')).toBeNull();
    expect(extractWidgetMetadata({ sub: 'u1' } as never, null)).toBeNull();
  });

  it('preserves nested values verbatim (rendered in detail, not as columns)', () => {
    const md = extractWidgetMetadata(
      { sub: 'u1', address: { city: 'NYC' }, tags: ['vip', 'beta'] } as never,
      'runhq_roles',
    );
    expect(md).toEqual({ address: { city: 'NYC' }, tags: ['vip', 'beta'] });
  });
});
