// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
//
// UserStore abstraction for the ported handlers.
//
// DRep Talk persists user identities in a D1 SQL table with INSERT … ON CONFLICT
// upsert semantics. drep-platform's live user model lives in DynamoDB. Because
// this module is NOT yet wired into the live handler path (per the brief —
// later sprint), the port defines a structural interface, ships an in-memory
// implementation for tests, and leaves the DynamoDB-backed adapter as a
// later concern. The handlers and their tests only know about this interface.

/** A writer role proven on-chain at login. */
export type AuthRole = 'drep' | 'proposer' | 'spo' | 'cc';

export interface User {
  id: string;
  drep_id: string | null;
  stake_addr: string | null;
  pool_id: string | null;
  cc_cred: string | null;
  is_drep: boolean;
  is_spo: boolean;
  is_cc: boolean;
  is_proposer: boolean;
  role: string;
  status: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  created_at: number;
  last_verified_at: number;
}

export interface UpsertArgs {
  drepId?: string;
  stakeAddr?: string;
  poolId?: string;
  ccCred?: string;
  roles: AuthRole[];
  now: number;
}

/**
 * Minimal user-store surface used by the ported handlers.
 *   - `upsertUserFromAuth` MUST be idempotent: re-running the same login
 *     updates `last_verified_at`, ORs in any new role flags, and fills in
 *     credential strings only when previously null (preserving the first
 *     value won).
 *   - `getUserById` returns null when no row exists.
 */
export interface UserStore {
  upsertUserFromAuth(args: UpsertArgs): Promise<User>;
  getUserById(id: string): Promise<User | null>;
}

// ---------------------------------------------------------------------------
// In-memory implementation for tests.
// ---------------------------------------------------------------------------

export class InMemoryUserStore implements UserStore {
  private readonly users = new Map<string, User>();

  async upsertUserFromAuth(args: UpsertArgs): Promise<User> {
    const { drepId, stakeAddr, poolId, ccCred, roles, now } = args;
    const id = drepId ?? stakeAddr ?? poolId ?? ccCred;
    if (!id) {
      throw new Error(
        'upsertUserFromAuth: at least one credential (drepId, stakeAddr, poolId, ccCred) must be provided',
      );
    }

    const existing = this.users.get(id);
    const next: User = {
      id,
      // First-non-null-wins: existing values are preserved.
      drep_id: existing?.drep_id ?? drepId ?? null,
      stake_addr: existing?.stake_addr ?? stakeAddr ?? null,
      pool_id: existing?.pool_id ?? poolId ?? null,
      cc_cred: existing?.cc_cred ?? ccCred ?? null,
      // OR-in role flags: once true, stays true.
      is_drep: (existing?.is_drep ?? false) || roles.includes('drep'),
      is_proposer: (existing?.is_proposer ?? false) || roles.includes('proposer'),
      is_spo: (existing?.is_spo ?? false) || roles.includes('spo'),
      is_cc: (existing?.is_cc ?? false) || roles.includes('cc'),
      role: existing?.role ?? 'member',
      status: existing?.status ?? 'active',
      display_name: existing?.display_name ?? null,
      bio: existing?.bio ?? null,
      avatar_url: existing?.avatar_url ?? null,
      created_at: existing?.created_at ?? now,
      last_verified_at: now,
    };
    this.users.set(id, next);
    return next;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  /** Test helper. */
  clear(): void {
    this.users.clear();
  }
}
