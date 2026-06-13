import React from 'react';
import { useTranslation } from 'react-i18next';
import { getLegalInfo } from '@/lib/legal';

/**
 * /privacy — GDPR-aligned privacy policy.
 *
 * Renders the controller details from VITE_LEGAL_* environment variables.
 * As with the imprint, the page renders cleanly without env vars — the
 * controller block falls back to `(not configured)` placeholders and we
 * surface a notice so a fresh repo in dev mode is never blank. The policy
 * text itself lives in the i18n bundle and matches what drep.tools
 * actually does: AWS hosting, Koios + Blockfrost reads, wallet-signature
 * auth, no advertising / third-party tracking.
 */
export function PrivacyPage(): React.ReactElement {
  const { t } = useTranslation();
  const legal = getLegalInfo();
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 text-[14.5px] leading-relaxed">
      <h1 className="text-2xl font-semibold mb-1">{t('legal.privacy.title')}</h1>
      <p className="text-[12.5px] text-[var(--text-secondary)] mb-4">
        {t('legal.privacy.lastUpdated')}
      </p>

      {!legal.configured && (
        <p
          className="rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] p-3 text-[13px] text-[var(--text-secondary)] mb-6"
          data-testid="legal-not-configured"
        >
          {t('legal.configurationNote')}
        </p>
      )}

      <p>{t('legal.privacy.intro')}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.controllerHeading')}
      </h2>
      <p>{t('legal.privacy.controllerIntro')}</p>
      <address className="not-italic mt-2" data-testid="privacy-controller">
        <div>{legal.operatorName}</div>
        {legal.addressLines.map((line, i) => (
          <div key={`${line}-${i}`}>{line}</div>
        ))}
        <div className="mt-2">
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
        </div>
      </address>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.processingHeading')}
      </h2>

      <h3 className="text-base font-semibold mt-4 mb-1">
        {t('legal.privacy.walletHeading')}
      </h3>
      <p>{t('legal.privacy.walletBody')}</p>

      <h3 className="text-base font-semibold mt-4 mb-1">
        {t('legal.privacy.contentHeading')}
      </h3>
      <p>{t('legal.privacy.contentBody')}</p>

      <h3 className="text-base font-semibold mt-4 mb-1">
        {t('legal.privacy.sessionHeading')}
      </h3>
      <p>{t('legal.privacy.sessionBody')}</p>

      <h3 className="text-base font-semibold mt-4 mb-1">
        {t('legal.privacy.logsHeading')}
      </h3>
      <p>{t('legal.privacy.logsBody')}</p>

      <h3 className="text-base font-semibold mt-4 mb-1">
        {t('legal.privacy.chainHeading')}
      </h3>
      <p>{t('legal.privacy.chainBody')}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.recipientsHeading')}
      </h2>
      <p>{t('legal.privacy.recipientsBody')}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.retentionHeading')}
      </h2>
      <p>{t('legal.privacy.retentionBody')}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.rightsHeading')}
      </h2>
      <p>
        {t('legal.privacy.rightsBodyPrefix')}
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
        {t('legal.privacy.rightsBodySuffix')}
      </p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.automatedHeading')}
      </h2>
      <p>{t('legal.privacy.automatedBody')}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">
        {t('legal.privacy.changesHeading')}
      </h2>
      <p>{t('legal.privacy.changesBody')}</p>
    </article>
  );
}
