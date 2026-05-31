/**
 * The deploy stage, baked in at build time via VITE_STAGE. Used to build the
 * stage-bound committee signing messages so they match what the backend
 * verifies (a test signature can't verify on prod). Defaults to 'dev'.
 */
export function getStage(): string {
  return (import.meta.env.VITE_STAGE as string | undefined) ?? 'dev';
}

/** True on the mainnet test environment — drives the "TEST" banner + the
 *  on-chain-submission-disabled messaging. */
export function isTestStage(): boolean {
  return getStage() === 'test';
}
