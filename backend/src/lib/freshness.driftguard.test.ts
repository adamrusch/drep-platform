import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift guard for the freshness/cadence single source of truth.
 *
 * The canonical text lives in `shared/freshness.ts`. Because the repo avoids
 * cross-workspace imports (see backend/src/lib/types.ts), the file is
 * duplicated byte-identically into:
 *   - `infra/lib/freshness.ts`         → driven by SchedulerStack
 *   - `frontend/src/lib/freshness.ts`  → driven by the /help/data-freshness page
 *
 * If those copies diverge from `shared/`, the help page can claim cadences
 * the scheduler doesn't actually run (or vice versa). This test pins the
 * three files to the same bytes so any drift is caught in CI rather than
 * shipped silently.
 *
 * The backend itself does not consume freshness directly — backend code is
 * just hosting the drift guard because it already has the biggest test
 * runner and the cross-tree fs path is straightforward. No backend handler
 * imports the freshness module.
 */
describe('freshness (drift guard — shared/infra/frontend must be byte-identical)', () => {
  const sharedPath = resolve(__dirname, '../../../shared/freshness.ts');
  const infraPath = resolve(__dirname, '../../../infra/lib/freshness.ts');
  const frontendPath = resolve(
    __dirname,
    '../../../frontend/src/lib/freshness.ts',
  );

  it('all three copies exist and are non-empty', () => {
    for (const p of [sharedPath, infraPath, frontendPath]) {
      const text = readFileSync(p, 'utf8');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('shared/freshness.ts and infra/lib/freshness.ts are byte-identical', () => {
    const shared = readFileSync(sharedPath, 'utf8');
    const infra = readFileSync(infraPath, 'utf8');
    expect(infra).toBe(shared);
  });

  it('shared/freshness.ts and frontend/src/lib/freshness.ts are byte-identical', () => {
    const shared = readFileSync(sharedPath, 'utf8');
    const frontend = readFileSync(frontendPath, 'utf8');
    expect(frontend).toBe(shared);
  });

  it('declares the v1 schema version (bump if the shape ever changes)', () => {
    const shared = readFileSync(sharedPath, 'utf8');
    expect(shared).toContain("FRESHNESS_SCHEMA_VERSION = 'v1'");
  });

  it('contains all 10 documented schedule ids (sanity)', () => {
    // The infra SchedulerStack today builds 10 EventBridge rules. Asserting
    // each id appears in the canonical freshness file pins the two together
    // — a removed schedule must remove the freshness row too, and a new
    // schedule must add one. Mirrors the rule-name suffix used in
    // `infra/lib/scheduler-stack.ts`.
    const shared = readFileSync(sharedPath, 'utf8');
    const required = [
      'governance-intake',
      'drep-directory',
      'vote-rationale',
      'drep-power-history',
      'pool-metadata',
      'cc-members',
      'revalidate-comment-stake',
      'committee-epoch-sweep',
      'revalidate-onchain-roles',
      'gc-avatars',
    ];
    for (const id of required) {
      expect(shared).toContain(`id: '${id}'`);
    }
  });
});
