/**
 * Decision #3 (2026-06-10) — unit tests for the canonical person +
 * identity-link store.
 *
 * Covers:
 *
 *   - `identityKeyFor` / `credentialTypeForRole` / `parseIdentityKey`
 *     namespace composition + round-trip.
 *   - `resolveOrProvisionPerson`: first login auto-provisions a fresh
 *     person + link; second login on the SAME credential returns the
 *     EXISTING personId (no second person minted).
 *   - `linkCredentialToPerson`: idempotent re-link to the same person;
 *     `AlreadyLinkedError` when the credential is mapped to a
 *     DIFFERENT person (the "no merge" safety guarantee).
 *   - `listPersonCredentials`: GSI Query returns every credential
 *     mapped to one person.
 *   - `updatePersonProfile`: profile patch updates the timestamp +
 *     persists provided fields; clearing via `null`.
 *
 * Mocks the dynamodb layer at the module boundary; the production
 * `identityPerson.ts` logic itself runs for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- In-memory DDB stub keyed by `<table>:<pk>` so a single store
// holds rows for both `onchain_users` and `identity_links`. The mock
// keeps the production code's contract: getItem returns undefined on
// miss; putItemIfAbsent returns 'written' on insert / 'skipped' on a
// pre-existing row at the same PK; queryItems returns every row
// whose `personId` matches the supplied :personId binding.
const store = new Map<string, Record<string, unknown>>();

function makeKey(table: string, pk: string): string {
  return `${table}::${pk}`;
}

vi.mock('./dynamodb', () => ({
  tableNames: {
    onchainUsers: 'test-onchain_users',
    identityLinks: 'test-identity_links',
  },
  getItem: vi.fn(async (table: string, key: Record<string, unknown>) => {
    const pk =
      (key['personId'] as string | undefined) ??
      (key['identityKey'] as string | undefined);
    if (!pk) return undefined;
    return store.get(makeKey(table, pk));
  }),
  putItem: vi.fn(async (table: string, item: Record<string, unknown>) => {
    const pk =
      (item['personId'] as string | undefined) ??
      (item['identityKey'] as string | undefined);
    if (!pk) throw new Error('mock putItem: row has no recognised PK');
    store.set(makeKey(table, pk), { ...item });
  }),
  putItemIfAbsent: vi.fn(
    async (
      table: string,
      item: Record<string, unknown>,
      keyAttrs: { partitionKey: string; sortKey?: string },
    ) => {
      const pk = item[keyAttrs.partitionKey] as string;
      const k = makeKey(table, pk);
      if (store.has(k)) {
        return { outcome: 'skipped' as const };
      }
      store.set(k, { ...item });
      return { outcome: 'written' as const };
    },
  ),
  queryItems: vi.fn(
    async (
      table: string,
      opts: {
        expressionAttributeValues: Record<string, unknown>;
      },
    ) => {
      const wanted = opts.expressionAttributeValues[':personId'];
      // Filter to rows belonging to the requested table — the
      // production GSI is scoped to identity_links; the unit test's
      // shared store also holds onchain_users person rows that
      // (perfectly legally) carry the same personId attribute. A
      // table-scoped filter mirrors the production behaviour.
      const prefix = `${table}::`;
      const items: Record<string, unknown>[] = [];
      for (const [k, row] of store.entries()) {
        if (!k.startsWith(prefix)) continue;
        if (row['personId'] !== wanted) continue;
        items.push(row);
      }
      items.sort((a, b) =>
        String(a['verifiedAt']).localeCompare(String(b['verifiedAt'])),
      );
      return { items, lastEvaluatedKey: undefined, count: items.length };
    },
  ),
}));

// Import AFTER the mock so the production code picks up our stubs.
import {
  AlreadyLinkedError,
  credentialTypeForRole,
  createPerson,
  getIdentityLink,
  getPerson,
  identityKeyFor,
  linkCredentialToPerson,
  listPersonCredentials,
  parseIdentityKey,
  resolveOrProvisionPerson,
  updatePersonProfile,
} from './identityPerson';

beforeEach(() => {
  store.clear();
});

describe('identityKeyFor + credentialTypeForRole + parseIdentityKey', () => {
  it('composes namespaced keys for every role', () => {
    expect(identityKeyFor('drep', 'drep1abc')).toBe('drep:drep1abc');
    expect(identityKeyFor('pool', 'pool1xyz')).toBe('pool:pool1xyz');
    expect(identityKeyFor('cc', 'cc_cold1foo')).toBe('cc:cc_cold1foo');
    expect(identityKeyFor('stake', 'stake1zzz')).toBe('stake:stake1zzz');
  });

  it('maps each on-chain role to a credential type', () => {
    expect(credentialTypeForRole('drep')).toBe('drep');
    expect(credentialTypeForRole('spo')).toBe('pool');
    expect(credentialTypeForRole('cc')).toBe('cc');
    // proposer collapses to a stake credential — proposers prove
    // control of a stake key, so the credential namespace IS `stake`.
    expect(credentialTypeForRole('proposer')).toBe('stake');
  });

  it('round-trips a key via parseIdentityKey', () => {
    const k = identityKeyFor('drep', 'drep1abc');
    const parsed = parseIdentityKey(k);
    expect(parsed).toEqual({ credentialType: 'drep', credentialId: 'drep1abc' });
  });

  it('rejects malformed keys', () => {
    expect(parseIdentityKey('no-colon')).toBeNull();
    expect(parseIdentityKey(':missing-type')).toBeNull();
    expect(parseIdentityKey('drep:')).toBeNull();
    // Bogus credential type — defensive guard, not in the union.
    expect(parseIdentityKey('unknown:value')).toBeNull();
  });

  it('throws on empty credential id at compose time', () => {
    expect(() => identityKeyFor('drep', '')).toThrow();
  });
});

describe('createPerson + getPerson', () => {
  it('mints a fresh row with ULID + timestamps', async () => {
    const person = await createPerson();
    expect(typeof person.personId).toBe('string');
    expect(person.personId.length).toBeGreaterThan(0);
    expect(person.createdAt).toBe(person.updatedAt);
    // Round-trip via getPerson.
    const read = await getPerson(person.personId);
    expect(read?.personId).toBe(person.personId);
  });

  it('returns undefined for an unknown personId', async () => {
    const read = await getPerson('does-not-exist');
    expect(read).toBeUndefined();
  });
});

describe('resolveOrProvisionPerson — login reconciliation', () => {
  it('auto-provisions a person + link on first login for an unmapped credential', async () => {
    const result = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    expect(result.created).toBe(true);
    expect(typeof result.personId).toBe('string');

    // The person row was minted.
    const person = await getPerson(result.personId);
    expect(person).toBeDefined();
    // The link row was minted with verifiedVia='login'.
    const link = await getIdentityLink(identityKeyFor('drep', 'drep1abc'));
    expect(link?.personId).toBe(result.personId);
    expect(link?.credentialType).toBe('drep');
    expect(link?.verifiedVia).toBe('login');
  });

  it('returns the EXISTING personId on a second login with the same credential', async () => {
    const first = await resolveOrProvisionPerson('pool', 'pool1abc', 'login');
    const second = await resolveOrProvisionPerson('pool', 'pool1abc', 'login');
    expect(second.personId).toBe(first.personId);
    expect(second.created).toBe(false);

    // No duplicate link or person row.
    const link = await getIdentityLink(identityKeyFor('pool', 'pool1abc'));
    expect(link?.personId).toBe(first.personId);
  });
});

describe('linkCredentialToPerson — explicit link flow', () => {
  it('maps a fresh credential to the caller person', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');

    const linkResult = await linkCredentialToPerson({
      credentialType: 'pool',
      credentialId: 'pool1abc',
      personId,
      linkedFromRole: 'drep',
    });
    expect(linkResult.alreadyLinked).toBe(false);

    const link = await getIdentityLink(identityKeyFor('pool', 'pool1abc'));
    expect(link?.personId).toBe(personId);
    expect(link?.credentialType).toBe('pool');
    expect(link?.verifiedVia).toBe('link');
    expect(link?.linkedFromRole).toBe('drep');
  });

  it('is idempotent — relinking the SAME credential to the SAME person returns alreadyLinked', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    // First link.
    await linkCredentialToPerson({
      credentialType: 'cc',
      credentialId: 'cc_cold1abc',
      personId,
    });
    // Second link — idempotent success.
    const second = await linkCredentialToPerson({
      credentialType: 'cc',
      credentialId: 'cc_cold1abc',
      personId,
    });
    expect(second.alreadyLinked).toBe(true);
  });

  it('REJECTS linking a credential that is already mapped to a DIFFERENT person', async () => {
    // Person A — signs up as a DRep.
    const a = await resolveOrProvisionPerson('drep', 'drep1a', 'login');
    // Person B — signs up as an SPO.
    const b = await resolveOrProvisionPerson('pool', 'pool1b', 'login');
    expect(a.personId).not.toBe(b.personId);

    // Now person A links a wallet stake credential.
    await linkCredentialToPerson({
      credentialType: 'stake',
      credentialId: 'stake1conflict',
      personId: a.personId,
    });

    // Person B tries to ALSO link the same stake credential —
    // must be rejected. SAFETY: no silent merge.
    await expect(
      linkCredentialToPerson({
        credentialType: 'stake',
        credentialId: 'stake1conflict',
        personId: b.personId,
      }),
    ).rejects.toBeInstanceOf(AlreadyLinkedError);

    // The original mapping is preserved unchanged.
    const link = await getIdentityLink(identityKeyFor('stake', 'stake1conflict'));
    expect(link?.personId).toBe(a.personId);
  });
});

describe('listPersonCredentials — GSI aggregation', () => {
  it('returns every credential mapped to a person, sorted by verifiedAt', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    // Insert a small delay between rows so the ISO-8601 sort key
    // differs on each one. Sub-millisecond minting would otherwise
    // yield duplicate timestamps in this test harness.
    await new Promise((res) => setTimeout(res, 10));
    await linkCredentialToPerson({
      credentialType: 'pool',
      credentialId: 'pool1abc',
      personId,
    });
    await new Promise((res) => setTimeout(res, 10));
    await linkCredentialToPerson({
      credentialType: 'cc',
      credentialId: 'cc_cold1abc',
      personId,
    });

    const creds = await listPersonCredentials(personId);
    expect(creds).toHaveLength(3);
    const keys = creds.map((c) => c.identityKey);
    expect(keys).toContain('drep:drep1abc');
    expect(keys).toContain('pool:pool1abc');
    expect(keys).toContain('cc:cc_cold1abc');
    // Sorted ascending by verifiedAt — drep was first.
    expect(creds[0]?.identityKey).toBe('drep:drep1abc');
  });

  it('returns an empty list for a person with no credentials', async () => {
    const person = await createPerson();
    const creds = await listPersonCredentials(person.personId);
    expect(creds).toEqual([]);
  });
});

describe('updatePersonProfile — patch semantics', () => {
  it('persists supplied fields and bumps updatedAt', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    const before = await getPerson(personId);
    expect(before?.updatedAt).toBeDefined();

    await new Promise((res) => setTimeout(res, 5));
    const updated = await updatePersonProfile(personId, {
      displayName: '  Alice  ',
      bio: 'on-chain operator',
      socialLinks: { twitter: 'alice' },
    });
    // Trimmed.
    expect(updated.displayName).toBe('Alice');
    expect(updated.bio).toBe('on-chain operator');
    expect(updated.socialLinks).toEqual({ twitter: 'alice' });
    expect(updated.updatedAt).not.toBe(before?.updatedAt);
    expect(updated.createdAt).toBe(before?.createdAt);
  });

  it('clears a field when patched with null', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    await updatePersonProfile(personId, { displayName: 'Alice' });

    const cleared = await updatePersonProfile(personId, { displayName: null });
    expect(cleared.displayName).toBeUndefined();
  });

  it('leaves other fields untouched on a partial patch', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    await updatePersonProfile(personId, {
      displayName: 'Alice',
      bio: 'hello',
    });
    const patched = await updatePersonProfile(personId, { bio: 'updated' });
    expect(patched.displayName).toBe('Alice');
    expect(patched.bio).toBe('updated');
  });

  it('throws when the person row is missing', async () => {
    await expect(
      updatePersonProfile('does-not-exist', { displayName: 'oops' }),
    ).rejects.toThrow(/not found/);
  });
});
