/** Deployment stage helpers. STAGE is injected into every Lambda's environment
 *  by the API stack (see infra/lib/api-stack.ts). */

export function currentStage(): string {
  return process.env['STAGE'] ?? 'dev';
}

export function isProd(): boolean {
  return currentStage() === 'prod';
}
