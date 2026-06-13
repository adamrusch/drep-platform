import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ExpandableTextProps {
  text: string;
  /** Classes for the text block (kept identical to the previous inline <p> so
   *  the look doesn't change — e.g. whitespace-pre-wrap, sizing, color). */
  className?: string;
  /** Roughly "a paragraph" when collapsed. Defaults to 6 lines. */
  collapsedLines?: number;
}

/**
 * Renders long text clamped to ~a paragraph with a "Show more" / "Show less"
 * toggle. The toggle only appears when the text actually overflows the clamp,
 * so short bodies render unchanged with no button. Uses a CSS line-clamp while
 * collapsed and measures scrollHeight vs clientHeight (re-measured on text
 * change and resize) to decide whether the toggle is needed.
 */
export function ExpandableText({
  text,
  className,
  collapsedLines = 6,
}: ExpandableTextProps): React.ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is intentionally tracked so the overflow check re-runs when content changes (not just on resize)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = (): void => {
      // Only meaningful while collapsed (clamped). When expanded the clamp is
      // off, so we keep the last known "overflowing" so the "Show less" button
      // stays rendered.
      if (expanded) return;
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div>
      <p
        ref={ref}
        className={className}
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: collapsedLines,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {text}
      </p>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="mt-1 text-[12.5px] font-medium text-[var(--brand-primary)] hover:underline focus-visible:outline-none"
        >
          {expanded ? t('common.showLess') : t('common.showMore')}
        </button>
      )}
    </div>
  );
}
