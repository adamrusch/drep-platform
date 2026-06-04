import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from './authStore';
import type { UserProfile } from '@/types';

const baseProfile = (over: Partial<UserProfile> = {}): UserProfile =>
  ({
    walletAddress: 'stake1uxw9d0q2xrua4hl4aeuszykc7n4wvvsax2fhn4mzr6qkw3spw2mv2',
    roles: ['delegator'],
    sessionType: 'wallet',
    ...over,
  }) as UserProfile;

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('starts with a null drepId', () => {
    expect(useAuthStore.getState().drepId).toBeNull();
  });

  // Regression: /auth/me is the only source that knows the live DRep linkage.
  // If setProfile fails to copy profile.drepId into the top-level slot,
  // s.drepId stays null and a real DRep is treated as "not registered"
  // (DRep dashboard + committee landing). See the deleted useAutoLinkDrep hook.
  it('setProfile syncs the live drepId into the top-level store slot', () => {
    useAuthStore.getState().setProfile(baseProfile({ drepId: 'drep1yg3eeezga' }));
    expect(useAuthStore.getState().drepId).toBe('drep1yg3eeezga');
  });

  it('setProfile syncs live roles into the top-level store slot', () => {
    useAuthStore.getState().setProfile(baseProfile({ roles: ['delegator', 'lead_drep'] }));
    expect(useAuthStore.getState().roles).toEqual(['delegator', 'lead_drep']);
  });

  it('setProfile without a drepId preserves an existing linked drepId', () => {
    useAuthStore.getState().setProfile(baseProfile({ drepId: 'drep1yg3eeezga' }));
    useAuthStore.getState().setProfile(baseProfile({ drepId: undefined }));
    expect(useAuthStore.getState().drepId).toBe('drep1yg3eeezga');
  });
});
