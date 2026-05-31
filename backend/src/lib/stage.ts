/** Deployment stage helpers. STAGE is injected into every Lambda's environment
 *  by the API stack (see infra/lib/api-stack.ts). */

export function currentStage(): string {
  return process.env['STAGE'] ?? 'dev';
}

export function isProd(): boolean {
  return currentStage() === 'prod';
}

/**
 * Whether the "paste a drep id" linking path is permitted. Pasting a drep1… id
 * proves only that the DRep is registered on-chain — NOT that the caller
 * controls it — so it's an impersonation vector. We allow it on non-prod stages
 * as a testing convenience (no on-chain broadcast happens there) and require the
 * CIP-95 proof-of-control path in production.
 */
export function pasteDrepLinkAllowed(): boolean {
  return !isProd();
}
