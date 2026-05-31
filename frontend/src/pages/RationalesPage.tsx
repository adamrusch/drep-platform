import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';

/**
 * Rationale browse surface. A finalized rationale is visible per governance
 * action (via the committee vote room). A dedicated public "all finalized
 * rationales" feed needs a backend list endpoint — tracked as a follow-up; for
 * now this page points members to their committee + the governance list.
 */
export function RationalesPage(): React.ReactElement {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">Rationales</h1>
      <Card>
        <CardHeader><CardTitle>Where to find rationales</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-[13.5px] text-[var(--text-secondary)]">
          <p>
            Each committee authors a rationale per governance action; once finalized it carries a
            CIP-100/108 anchor hash and (after pinning) an IPFS URI embedded in the on-chain vote.
          </p>
          <p>
            Open a{' '}
            <Link to="/committee" className="text-[var(--brand-primary)] hover:underline">committee</Link>
            {' '}or browse{' '}
            <Link to="/governance" className="text-[var(--brand-primary)] hover:underline">governance actions</Link>
            {' '}to see the associated proposal and rationale.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
