import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Site-wide footer rendered at the bottom of the main content column.
 *
 * Surfaces operational and legal pages that should be one click away from
 * any view: data freshness, imprint, privacy, security, contributing. The
 * data-freshness page is driven by the same `FRESHNESS` table that the
 * infra scheduler reads, so the cadences advertised there can never drift
 * from what the platform actually runs.
 *
 * The footer is intentionally a calm, low-affordance band — small text on
 * the bg-app token, no borders heavy enough to compete with the page
 * content above. It always renders inside `<main>` so the grid layout in
 * `design-system.css` (.app has only `topbar` + `sidebar` + `main` grid
 * areas) does not need a new area.
 *
 * Internal links use `<Link>` to keep the SPA's router; the external
 * Security/Contributing pointers go to the repo files at the repo root so
 * the live site does not need to mirror the policies as separate routes.
 */
export function Footer(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <footer
      className="mt-10 pt-6 border-t border-[var(--border-default)] text-[12.5px] text-[var(--text-secondary)]"
      data-testid="site-footer"
    >
      <nav
        className="flex flex-wrap gap-x-4 gap-y-2 items-center"
        aria-label="Footer"
      >
        <Link
          to="/help/data-freshness"
          className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
        >
          {t('footer.dataFreshness')}
        </Link>
        <Link
          to="/imprint"
          className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
        >
          {t('footer.imprint')}
        </Link>
        <Link
          to="/privacy"
          className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
        >
          {t('footer.privacy')}
        </Link>
        <a
          href="https://github.com/adamrusch/drep-platform/blob/main/SECURITY.md"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
        >
          {t('footer.security')}
        </a>
        <a
          href="https://github.com/adamrusch/drep-platform/blob/main/CONTRIBUTING.md"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
        >
          {t('footer.contributing')}
        </a>
      </nav>
    </footer>
  );
}
