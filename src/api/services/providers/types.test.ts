import { describe, it, expectTypeOf } from 'vitest';
import type { ProviderId } from './types';

describe('ProviderId', () => {
  it('includes docker', () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<'fly' | 'docker'>();
  });
});
