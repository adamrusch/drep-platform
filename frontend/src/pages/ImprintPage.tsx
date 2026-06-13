import React from 'react';
import { useTranslation } from 'react-i18next';
import { getLegalInfo } from '@/lib/legal';

/**
 * /imprint — operator imprint (Impressum).
 *
 * Renders the operator details from VITE_LEGAL_* environment variables.
 * When the env vars are unset the page still renders cleanly — the parser
 * substitutes `(not configured)` placeholders and we surface a small
 * notice up top, so a freshly cloned repo in dev mode is never blank. The
 * policy text itself is in the i18n bundle, so localisation is consistent
 * with the rest of the app.
 */
export function ImprintPage(): React.ReactElement {
  const { t } = useTranslation();
  const legal = getLegalInfo();
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 text-[14.5px] leading-relaxed">
      <h1 className="text-2xl font-semibold mb-4">{t('legal.imprint.title')}</h1>
      {!legal.configured && (
        <p
          className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] p-3 text-[13px] text-[var(--text-secondary)] mb-6"
          data-testid="legal-not-configured"
        >
          {t('legal.configurationNote')}
        </p>
      )}

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.imprint.operatorHeading')}
      </h2>
      <address className="not-italic" data-testid="imprint-operator">
        <div>{legal.operatorName}</div>
        {legal.addressLines.map((line, i) => (
          // The address can be 1-N lines depending on the operator's
          // VITE_LEGAL_OPERATOR_ADDRESS env (split on "|" / newline).
          // Using the index in the key is safe — the array length and
          // ordering are stable for a given build.
          <div key={`${line}-${i}`}>{line}</div>
        ))}
      </address>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.imprint.contactHeading')}
      </h2>
      <p>
        Email:{' '}
        {legal.email && legal.email !== t('legal.notConfigured') ? (
          <a
            href={`mailto:${legal.email}`}
            className="text-[var(--brand-primary)] underline-offset-2 hover:underline"
          >
            {legal.email}
          </a>
        ) : (
          <span>{legal.email}</span>
        )}
        {legal.phone && (
          <>
            <br />
            Phone: {legal.phone}
          </>
        )}
      </p>

      {legal.vatId && (
        <>
          <h2 className="text-lg font-semibold mt-6 mb-2">
            {t('legal.imprint.vatHeading')}
          </h2>
          <p>{legal.vatId}</p>
        </>
      )}

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.imprint.responsibleHeading')}
      </h2>
      <p>{legal.responsiblePerson}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.imprint.aboutHeading')}
      </h2>
      <p>{t('legal.imprint.aboutBody')}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.imprint.liabilityHeading')}
      </h2>
      <p>{t('legal.imprint.liabilityBody')}</p>
    </article>
  );
}
