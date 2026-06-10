// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Converted from `session.workers.test.ts` to run on vitest's Node pool using
// the in-memory SessionStore fake.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  getSession,
  revokeSession,
  revokeAllForUser,
  buildSessionCookie,
  clearSessionCookie,
  parseSessionToken,
} from './session';
import { InMemorySessionStore } from '../stores/sessionStore';

let store: InMemorySessionStore;

beforeEach(() => {
  store = new InMemorySessionStore();
});

describe('createSession + getSession round-trip', () => {
  it('returns the session record for a fresh token', async () => {
    const now = 1_700_000_000;
    const token = await createSession(store, { id: 'user-1', roles: ['voter'] }, { now });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const record = await getSession(store, token, { now });
    expect(record).not.toBeNull();
    expect(record?.userId).toBe('user-1');
    expect(record?.roles).toEqual(['voter']);
    expect(record?.createdAt).toBe(now);
    expect(record?.lastSeen).toBe(now);
  });

  it('stores the token hashed so the raw token is not present in the store', async () => {
    const token = await createSession(store, { id: 'user-hash-check', roles: [] });
    // The store should NOT contain the raw token as a key.
    const direct = await store.get(token);
    expect(direct).toBeNull();
  });
});

describe('getSession sliding renewal', () => {
  it('refreshes lastSeen when now is more than 6h after lastSeen', async () => {
    const createdAt = 1_700_000_000;
    const token = await createSession(store, { id: 'user-2', roles: [] }, { now: createdAt });

    const earlyNow = createdAt + 3600;
    const earlyRecord = await getSession(store, token, { now: earlyNow });
    expect(earlyRecord?.lastSeen).toBe(createdAt);

    const laterNow = createdAt + 21_601;
    const laterRecord = await getSession(store, token, { now: laterNow });
    expect(laterRecord?.lastSeen).toBe(laterNow);

    const finalRecord = await getSession(store, token, { now: laterNow + 1 });
    expect(finalRecord?.lastSeen).toBe(laterNow);
  });

  it('keeps the usess index alive after sliding renewal', async () => {
    const createdAt = 1_700_000_000;
    const userId = 'user-renewal-index';
    const token = await createSession(store, { id: userId, roles: [] }, { now: createdAt });

    const laterNow = createdAt + 21_601;
    await getSession(store, token, { now: laterNow });

    const indexRaw = await store.get(`usess:${userId}`);
    expect(indexRaw).not.toBeNull();
    const index = JSON.parse(indexRaw as string) as string[];
    expect(index.length).toBeGreaterThan(0);
  });
});

describe('revokeSession', () => {
  it('makes getSession return null after revocation', async () => {
    const token = await createSession(store, { id: 'user-3', roles: [] });
    expect(await getSession(store, token)).not.toBeNull();

    await revokeSession(store, token);
    expect(await getSession(store, token)).toBeNull();
  });

  it('does not throw for an unknown token', async () => {
    const fakeToken = 'totallyUnknownTokenThatDoesNotExist';
    await expect(revokeSession(store, fakeToken)).resolves.toBeUndefined();
  });

  it('removes the hash from the per-user index after revocation', async () => {
    const userId = 'user-index-prune';
    const t1 = await createSession(store, { id: userId, roles: [] });
    const t2 = await createSession(store, { id: userId, roles: [] });

    await revokeSession(store, t1);

    expect(await getSession(store, t1)).toBeNull();
    expect(await getSession(store, t2)).not.toBeNull();

    await revokeSession(store, t2);
    expect(await getSession(store, t2)).toBeNull();
  });
});

describe('revokeAllForUser', () => {
  it('revokes all sessions for a user', async () => {
    const userId = 'user-multi';
    const t1 = await createSession(store, { id: userId, roles: ['a'] });
    const t2 = await createSession(store, { id: userId, roles: ['b'] });
    const t3 = await createSession(store, { id: userId, roles: ['c'] });

    expect(await getSession(store, t1)).not.toBeNull();
    expect(await getSession(store, t2)).not.toBeNull();
    expect(await getSession(store, t3)).not.toBeNull();

    await revokeAllForUser(store, userId);

    expect(await getSession(store, t1)).toBeNull();
    expect(await getSession(store, t2)).toBeNull();
    expect(await getSession(store, t3)).toBeNull();
  });

  it('leaves other users sessions intact', async () => {
    const tOther = await createSession(store, { id: 'user-other', roles: [] });
    const tTarget = await createSession(store, { id: 'user-target', roles: [] });

    await revokeAllForUser(store, 'user-target');

    expect(await getSession(store, tOther)).not.toBeNull();
    expect(await getSession(store, tTarget)).toBeNull();
  });

  it('does not throw for a user with no sessions', async () => {
    await expect(revokeAllForUser(store, 'non-existent-user')).resolves.toBeUndefined();
  });
});

describe('corrupt usess index handling', () => {
  it('createSession recovers when the index contains corrupt JSON', async () => {
    const userId = 'user-corrupt-create';
    await store.put(`usess:${userId}`, 'not-valid-json', 60);
    const token = await createSession(store, { id: userId, roles: [] });
    expect(typeof token).toBe('string');
    const record = await getSession(store, token);
    expect(record).not.toBeNull();
  });

  it('revokeAllForUser deletes the corrupt index and returns without throwing', async () => {
    const userId = 'user-corrupt-revoke-all';
    await store.put(`usess:${userId}`, '!!!bad json!!!', 60);
    await expect(revokeAllForUser(store, userId)).resolves.toBeUndefined();
    const gone = await store.get(`usess:${userId}`);
    expect(gone).toBeNull();
  });
});

describe('getSession with unknown or garbage tokens', () => {
  it('returns null for an unknown token (no throw)', async () => {
    expect(await getSession(store, 'noSuchToken')).toBeNull();
  });

  it('returns null for an empty string token (no throw)', async () => {
    expect(await getSession(store, '')).toBeNull();
  });

  it('returns null for a garbage token string (no throw)', async () => {
    expect(await getSession(store, '!!@@##$$%%^^&&**()')).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('buildSessionCookie contains the token and required flags', () => {
    const token = 'myTestToken';
    const cookie = buildSessionCookie(token);
    expect(cookie).toContain(`dreptalk_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('buildSessionCookie omits Secure when secure:false is passed', () => {
    const token = 'localDevToken';
    const cookie = buildSessionCookie(token, { secure: false });
    expect(cookie).toContain(`dreptalk_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('buildSessionCookie honours a custom cookie name', () => {
    const cookie = buildSessionCookie('x', { cookieName: 'custom_session' });
    expect(cookie.startsWith('custom_session=x;')).toBe(true);
  });

  it('clearSessionCookie has Max-Age=0', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain('dreptalk_session=');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });

  it('parseSessionToken extracts the token from a valid Cookie header', () => {
    const token = 'abc123def456';
    const header = `other_cookie=val; dreptalk_session=${token}; another=x`;
    expect(parseSessionToken(header)).toBe(token);
  });

  it('parseSessionToken returns null when the cookie is absent', () => {
    expect(parseSessionToken('other=val; foo=bar')).toBeNull();
  });

  it('parseSessionToken returns null for null input', () => {
    expect(parseSessionToken(null)).toBeNull();
  });

  it('parseSessionToken returns null for an empty cookie header', () => {
    expect(parseSessionToken('')).toBeNull();
  });

  it('parseSessionToken honours a custom cookie name', () => {
    const token = 'xyz';
    const header = `custom_session=${token}`;
    expect(parseSessionToken(header, { cookieName: 'custom_session' })).toBe(token);
  });
});
