import { useTranslation } from 'react-i18next';
import { FRESHNESS } from '@/lib/freshness';

/**
 * Public /help/data-freshness page.
 *
 * Renders the canonical FRESHNESS table from `frontend/src/lib/freshness.ts`,
 * which is a byte-identical mirror of `shared/freshness.ts` (and the
 * `infra/lib/freshness.ts` copy that drives the SchedulerStack). Because the
 * same table also drives the EventBridge cadences via
 * `scheduleFromFreshness(...)` in the infra stack, the cadences this page
 * advertises can never drift from what the platform actually runs — a
 * backend drift-guard test pins all three files to the same bytes.
 *
 * Page is public (no auth, no role gate) — these are operational
 * commitments about how often the platform's on-chain caches refresh, and
 * users should be able to find them without signing in.
 */
export function HelpDataFreshness(): React.ReactElement {
  const { t } = useTranslation();

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">
        {t('help.dataFreshness.title')}
      </h1>
      <p className="text-[var(--text-secondary)] mb-6 text-[14.5px] leading-relaxed">
        {t('help.dataFreshness.intro')}
      </p>

      <div className="overflow-x-auto">
        <table
          className="w-full border-collapse text-[14px]"
          // `data-testid` lets the page test query the table without
          // depending on a specific localized header string.
          data-testid="freshness-table"
        >
          <thead>
            <tr className="text-left border-b-2 border-[var(--border-default)]">
              <th className="py-2 pr-3">{t('help.dataFreshness.col.data')}</th>
              <th className="py-2 pr-3 whitespace-nowrap">
                {t('help.dataFreshness.col.refresh')}
              </th>
              <th className="py-2 pl-3">{t('help.dataFreshness.col.notes')}</th>
            </tr>
          </thead>
          <tbody>
            {FRESHNESS.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[var(--border-default)] align-top"
                data-testid={`freshness-row-${row.id}`}
              >
                <td className="py-2 pr-3 font-medium">{row.label}</td>
                <td className="py-2 pr-3 text-[var(--text-secondary)] whitespace-nowrap">
                  {row.cadence}
                </td>
                <td className="py-2 pl-3 text-[var(--text-secondary)]">
                  {row.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p
        className="mt-6 text-[12.5px] text-[var(--text-tertiary,var(--text-secondary))]"
        // The footnote names the single source so an operator reading the
        // page can find where to change a cadence.
      >
        {t('help.dataFreshness.footnote')}
      </p>
    </article>
  );
}
