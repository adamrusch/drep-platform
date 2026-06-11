// Sprint 5 — DRep avatar URL helper tests. Pins both branches:
//   1. self-hosted: `/api/avatar/<hash>` when a content hash is set
//   2. fallback: deterministic cardenticon SVG data URL (no network)

import { describe, it, expect } from 'vitest';
import { resolveDrepAvatarUrl } from './drepAvatar';

describe('resolveDrepAvatarUrl', () => {
  it('returns the self-hosted /api/avatar/<hash> URL when a content hash is set', () => {
    const url = resolveDrepAvatarUrl({
      drepId: 'drep1xxx',
      imageContentHash: 'abcdef0123456789'.repeat(4), // 64-char hex
    });
    expect(url).toContain('/avatar/');
    expect(url).toContain('abcdef0123456789'.repeat(4));
  });

  it('falls back to a cardenticon data URL when no hash is set', () => {
    const url = resolveDrepAvatarUrl({ drepId: 'drep1xxx' });
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('falls back to a cardenticon data URL when the hash is null', () => {
    const url = resolveDrepAvatarUrl({ drepId: 'drep1xxx', imageContentHash: null });
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('identicon fallback is DETERMINISTIC for the same drep id', () => {
    const a = resolveDrepAvatarUrl({ drepId: 'drep1same' });
    const b = resolveDrepAvatarUrl({ drepId: 'drep1same' });
    expect(a).toBe(b);
  });

  it('identicon fallback DIFFERS across different drep ids', () => {
    const a = resolveDrepAvatarUrl({ drepId: 'drep1one' });
    const b = resolveDrepAvatarUrl({ drepId: 'drep1two' });
    expect(a).not.toBe(b);
  });
});
