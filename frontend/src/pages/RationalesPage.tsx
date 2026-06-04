import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';

/**
 * Rationale browse surface. A finalized rationale is visible per governance
 * action (via the committee vote room). A dedicated public "all finalized
 * rationales" feed needs a backend list endpoint — tracked as a follow-up; for
 * now this page points members to their committee + the governance list.
 */
export function RationalesPage(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('rationales.title')}</h1>
      <Card>
        <CardHeader><CardTitle>{t('rationales.whereTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-[13.5px] text-[var(--text-secondary)]">
          <p>{t('rationales.para1')}</p>
          <p>
            {t('rationales.openA')}{' '}
            <Link to="/committee" className="text-[var(--brand-primary)] hover:underline">{t('rationales.committee')}</Link>
            {' '}{t('rationales.orBrowse')}{' '}
            <Link to="/governance" className="text-[var(--brand-primary)] hover:underline">{t('rationales.governanceActions')}</Link>
            {' '}{t('rationales.toSee')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
