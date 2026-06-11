import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift guard for the CIP-20 (label 674) attribution helper.
 *
 * The canonical text lives in `shared/cip20.ts`. The repo avoids
 * cross-workspace imports (see backend/src/lib/types.ts), so the helper
 * is duplicated byte-identically into `frontend/src/lib/cip20.ts` —
 * which the live `buildUnsignedVoteTx` consumes to stamp every drep.tools
 * vote with attribution metadata.
 *
 * If the copies diverge, the deployed bundle could stamp votes with a
 * different format than the source-of-truth comment claims, and the
 * "Voted via drep.tools" attribution scheme becomes ambiguous. This test
 * pins the two files to the same bytes so any drift is caught in CI.
 *
 * The backend does not consume the helper directly (the tx is assembled
 * client-side); backend just hosts the drift test because it has the
 * biggest test runner.
 */
describe('cip20 (drift guard — shared/ and frontend/ must be byte-identical)', () => {
  const sharedPath = resolve(__dirname, '../../../shared/cip20.ts');
  const frontendPath = resolve(__dirname, '../../../frontend/src/lib/cip20.ts');

  it('both copies exist and are non-empty', () => {
    for (const p of [sharedPath, frontendPath]) {
      const text = readFileSync(p, 'utf8');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('shared/cip20.ts and frontend/src/lib/cip20.ts are byte-identical', () => {
    const shared = readFileSync(sharedPath, 'utf8');
    const frontend = readFileSync(frontendPath, 'utf8');
    expect(frontend).toBe(shared);
  });

  it('canonical copy declares CIP-20 label 674 and the v1 helper version', () => {
    const shared = readFileSync(sharedPath, 'utf8');
    expect(shared).toContain('CIP20_LABEL = 674');
    expect(shared).toContain("CIP20_HELPER_VERSION = 'v1'");
    expect(shared).toContain('CIP20_MAX_CHUNK_BYTES = 64');
  });
});
