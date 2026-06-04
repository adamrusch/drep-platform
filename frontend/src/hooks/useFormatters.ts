import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Locale-aware formatters for relative time, ADA amounts, and epoch dates.
 * Use these (not the plain functions in `@/lib/utils`) inside components so the
 * output follows the active language — "3h ago" ⇄ "3時間前", and number/date
 * formatting follows the locale. These format only PLATFORM-generated values
 * (timestamps, lovelace, epoch numbers); on-chain/external text is never
 * touched here.
 */
export function useFormatters(): {
  formatRelativeTime: (isoDate: string) => string;
  formatLovelace: (lovelace: string) => string;
  formatEpochDate: (epoch: number, networkEpochDurationMs?: number) => string;
} {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith('ja') ? 'ja-JP' : 'en-US';

  const formatRelativeTime = useCallback(
    (isoDate: string): string => {
      const date = new Date(isoDate);
      const diffMs = Date.now() - date.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      if (diffSecs < 60) return t('time.justNow');
      if (diffMins < 60) return t('time.minutesAgo', { count: diffMins });
      if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
      if (diffDays < 30) return t('time.daysAgo', { count: diffDays });
      return date.toLocaleDateString(locale);
    },
    [t, locale],
  );

  const formatLovelace = useCallback(
    (lovelace: string): string => {
      const ada = Number(lovelace) / 1_000_000;
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(ada) + ' ADA';
    },
    [locale],
  );

  const formatEpochDate = useCallback(
    (epoch: number, networkEpochDurationMs = 5 * 24 * 60 * 60 * 1000): string => {
      const EPOCH_0_UNIX_MS = 1_506_203_091_000;
      const ts = EPOCH_0_UNIX_MS + epoch * networkEpochDurationMs;
      return new Date(ts).toLocaleDateString(locale);
    },
    [locale],
  );

  return { formatRelativeTime, formatLovelace, formatEpochDate };
}
