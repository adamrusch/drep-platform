// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Structural KoiosClient interface used by the identity role resolvers.
//
// Why a local interface (not an import from the legacy `src/lib/koios.ts`):
// the resolvers should depend only on the shape they actually use. A
// drep-platform-specific adapter (lib/identity/stores or a future
// adapters file) implements this interface over the real Koios client; tests
// supply a fake.

/**
 * Subset of the Koios `/drep_info` row needed by `resolveDRep`. Mirrors the
 * fields DRep Talk's resolver references and forms a stable surface even as
 * the upstream payload evolves.
 */
export interface DrepInfo {
  drep_id: string;
  hex: string | null;
  has_script: boolean;
  drep_status: string;
  deposit: string | null;
  active: boolean;
  expires_epoch_no: number | null;
}

/** Subset of an account_info row — currently unused by the ported resolvers
 *  but referenced by the test fakes to mirror DRep Talk's client surface. */
export interface AccountInfo {
  stake_address: string;
  total_balance: string;
  status: string | null;
}

/** Subset of a Koios `/proposal_list` row (or equivalent) needed by
 *  `resolveProposer`. */
export interface Proposal {
  proposal_id: string;
  return_address: string;
  proposal_type: string;
}

/**
 * Subset of a Koios `/pool_calidus_keys` row needed by `resolveSpo`. Koios
 * returns the bech32 pool id, the calidus public key in hex, and lifecycle
 * fields used to detect revocation.
 */
export interface PoolCalidusKeyRow {
  pool_id_bech32: string;
  calidus_pub_key: string;
  calidus_id_bech32: string;
  registered: boolean;
  pool_status: string;
}

/**
 * Subset of a Koios `/committee_info.members` row needed by `resolveCc`.
 * Both hot and cold credential ids may be null while the lifecycle bucket
 * (status) and the script flags decide eligibility.
 */
export interface CommitteeMember {
  status: string;
  cc_hot_id: string | null;
  cc_cold_id: string | null;
  cc_hot_hex: string | null;
  cc_cold_hex: string | null;
  expiration_epoch: number | null;
  cc_hot_has_script: boolean | null;
  cc_cold_has_script: boolean | null;
}

/**
 * Minimal structural interface satisfied by a production Koios adapter and
 * by test fakes. Keeping this lean (only the methods the resolvers call)
 * keeps the test surface small and the dependency on Koios scoped.
 */
export interface KoiosClient {
  drepInfo(drepId: string): Promise<DrepInfo | null>;
  proposalsByReturnAddress(stakeAddress: string): Promise<Proposal[]>;
  poolCalidusKey(calidusPubKeyHex: string): Promise<PoolCalidusKeyRow | null>;
  committeeInfo(): Promise<CommitteeMember[]>;
}
