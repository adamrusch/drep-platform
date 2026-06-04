/** Deployment stage helpers. STAGE is injected into every Lambda's environment
 *  by the API stack (see infra/lib/api-stack.ts). */

import type { AuthContext } from '../middleware/role-guard';
import { isPlatformAdmin } from './platformAdmin';

export function currentStage(): string {
  return process.env['STAGE'] ?? 'dev';
}

export function isProd(): boolean {
  return currentStage() === 'prod';
}

/**
 * Gate for broadcasting / recording a REAL on-chain CIP-1694 DRep vote.
 *
 * # The safety contract — read carefully
 *
 * Today both the test (`test.drep.tools`) and prod (`drep.tools`)
 * environments are wired to MAINNET. There is no preview/preprod
 * "rehearsal" path — anything that broadcasts is a real, recorded vote on a
 * live governance action, costs real ADA, and is visible on Cardanoscan and
 * gov.tools. This predicate is the LAST in-code wall between an accidental
 * test-environment click and an irrevocable mainnet vote.
 *
 * Stage rules:
 *   - `prod` — any caller that already passes `assertCommitteeLead` (which
 *     gates separately on committee leadership) may broadcast. Returning
 *     `true` here is exactly the historical behaviour for prod.
 *   - `test` — the lead alone is NOT enough. The caller must ALSO be a
 *     `platform_admin` (persisted role or bootstrap-listed wallet). This is
 *     the "test casts real mainnet votes → keep the surface tiny" gate.
 *   - everything else (`dev`, unset) — never; non-deployed stages have no
 *     business broadcasting.
 *
 * The committee-lead check is intentionally NOT moved into this function —
 * `assertCommitteeLead` is resource-scoped (this caller leads THIS
 * committee) while platform-admin is a global role. Composing them at the
 * call site keeps each predicate doing one thing.
 */
export function canBroadcastGovernanceVote(authCtx: AuthContext): boolean {
  const stage = currentStage();
  if (stage === 'prod') return true;
  if (stage === 'test') return isPlatformAdmin(authCtx);
  return false;
}
