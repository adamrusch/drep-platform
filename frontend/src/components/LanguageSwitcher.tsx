import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Check } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * Compact language switcher for the topbar. Shows the current language's short
 * code (EN / JP) with a globe icon; opens a small menu to pick a language.
 * The choice is persisted by i18next's language detector (localStorage:
 * `drep_lang`).
 */
export function LanguageSwitcher(): React.ReactElement {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const current =
    SUPPORTED_LANGUAGES.find((l) => i18n.language?.startsWith(l.code)) ?? SUPPORTED_LANGUAGES[0];

  const pick = (code: string): void => {
    void i18n.changeLanguage(code);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('language.label')}
        className="inline-flex items-center gap-1.5 rounded-token-md border border-[var(--border-default)] px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] focus-visible:outline-none"
      >
        <Globe size={15} strokeWidth={1.75} aria-hidden="true" />
        <span>{current.short}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-40 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] shadow-token-sm py-1 z-50"
        >
          {SUPPORTED_LANGUAGES.map((l) => {
            const active = current.code === l.code;
            return (
              <button
                key={l.code}
                role="menuitem"
                type="button"
                onClick={() => pick(l.code)}
                className={cn(
                  'flex w-full items-center justify-between px-3 py-2 text-[13px] hover:bg-[var(--bg-muted)]',
                  active ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]',
                )}
              >
                <span>{l.label}</span>
                {active && <Check size={14} strokeWidth={2.25} className="text-[var(--brand-primary)]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
