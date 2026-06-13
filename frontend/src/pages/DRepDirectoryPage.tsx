import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Search as SearchIcon,
  Users as UsersIcon,
  Vote as VoteIcon,
} from 'lucide-react';
import { get } from '@/lib/api';
import { StatusPill } from '@/components/ui/StatusPill';
import DrepConcentration from '@/components/DrepConcentration';
import { useFormatters } from '@/hooks/useFormatters';
import { useDrepConcentration } from '@/hooks/useDrepConcentration';
import { resolveDrepAvatarUrl } from '@/lib/drepAvatar';
import { cn } from '@/lib/utils';
import type { DRepDirectoryEntry, PaginatedResponse } from '@/types';

type SortKey = 'power' | 'delegators' | 'recent' | 'name';

/** Sort options. Labels are resolved at render time via `t('drepDirectory.sort.<id>')`. */
const SORT_OPTIONS: Array<{ id: SortKey }> = [
  { id: 'name' },
  { id: 'power' },
  { id: 'recent' },
  { id: 'delegators' },
];

/** Allowed page-size choices. The backend caps at 100; values are
 *  hard-coded so the dropdown doesn't drift from server limits. */
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];
const DEFAULT_PAGE_SIZE: PageSize = 25;

/**
 * Lightweight debounce for the search input. Avoids hammering the
 * backend Scan on every keystroke. 250ms feels responsive.
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

/** Truncate a `drep1...` ID to a glance-readable form. */
function shortDRepId(drepId: string): string {
  if (drepId.length <= 18) return drepId;
  return `${drepId.slice(0, 12)}…${drepId.slice(-6)}`;
}

/** Generate a deterministic background color for the initial-letter avatar
 *  so the same DRep ID always renders the same color. Hue derived from a
 *  cheap string hash; saturation/lightness are fixed for visual cohesion. */
function avatarColor(drepId: string): string {
  let h = 0;
  for (let i = 0; i < drepId.length; i++) {
    h = (h * 31 + drepId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 75%)`;
}

interface AvatarProps {
  drepId: string;
  name?: string;
  /** Sprint 5 — sha256-hex of the self-hosted avatar bytes living at
   *  `/api/avatar/<hash>`. When set, we serve the validated, S3-stored
   *  bytes (immutable, CloudFront-cached). When absent, we render a
   *  deterministic cardenticon identicon keyed by drepId. */
  imageContentHash?: string | null;
  size?: number;
}

function DRepAvatar({
  drepId,
  name,
  imageContentHash,
  size = 48,
}: AvatarProps): React.ReactElement {
  const [errored, setErrored] = useState(false);
  // Identicon fallback covers two paths: (a) no self-hosted avatar yet
  // (`imageContentHash` is null/undefined), and (b) the `/api/avatar/<hash>`
  // request failed for any reason (404, network blip). Both surface the
  // same deterministic identicon, which is by-design indistinguishable
  // from the "never had an avatar" case from the user's perspective.
  const src = useMemo(
    () => resolveDrepAvatarUrl({ drepId, imageContentHash, size }),
    [drepId, imageContentHash, size],
  );
  // Use the resolved src for the first attempt; on failure fall back to a
  // pure identicon (regardless of what the initial hash said). The
  // identicon path can't fail — it's a data: URL synthesized in the
  // browser, no network.
  const finalSrc = useMemo(
    () => (errored ? resolveDrepAvatarUrl({ drepId, size }) : src),
    [errored, drepId, size, src],
  );
  void name;
  return (
    <div
      className="flex-shrink-0 inline-flex items-center justify-center rounded-token-full overflow-hidden"
      style={{
        width: size,
        height: size,
        background: avatarColor(drepId),
      }}
      aria-hidden="true"
    >
      <img
        src={finalSrc}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setErrored(true)}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

/**
 * Render the "Voted X ago" / "Never voted" tag. Color cues match
 * recency: green for recent (<7d), neutral for older, muted for stale
 * (>30d), and tertiary-text for never-voted. Inactive DReps get the
 * Inactive badge separately — this badge renders for them too, since
 * the lastVotedAt is still informative ("Voted 4mo ago").
 */
function LastVotedTag({
  lastVotedAt,
  voteCount,
}: {
  lastVotedAt?: string;
  voteCount?: number;
}): React.ReactElement {
  const { t } = useTranslation();
  const { formatRelativeTime } = useFormatters();
  if (!lastVotedAt) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[var(--text-tertiary)]"
        title={t('drepDirectory.neverVotedTitle')}
      >
        <VoteIcon size={11} strokeWidth={2} aria-hidden="true" />
        {t('drepDirectory.neverVoted')}
      </span>
    );
  }
  const ageMs = Date.now() - new Date(lastVotedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // Color tiers — keep these in sync with the CSS variables so they
  // adapt to dark mode. We don't use raw hex colors here.
  let colorClass: string;
  if (ageDays < 7) {
    colorClass = 'text-[var(--success)]';
  } else if (ageDays < 30) {
    colorClass = 'text-[var(--text-secondary)]';
  } else {
    colorClass = 'text-[var(--text-tertiary)]';
  }
  const tooltip =
    typeof voteCount === 'number' && voteCount > 0
      ? t('drepDirectory.voteTooltipWithCount', {
          count: voteCount,
          date: new Date(lastVotedAt).toLocaleString(),
        })
      : t('drepDirectory.voteTooltipNoCount', {
          date: new Date(lastVotedAt).toLocaleString(),
        });
  return (
    <span
      className={cn('inline-flex items-center gap-1 tabular-nums', colorClass)}
      title={tooltip}
    >
      <VoteIcon size={11} strokeWidth={2} aria-hidden="true" />
      {t('drepDirectory.votedAgo', { time: formatRelativeTime(lastVotedAt) })}
    </span>
  );
}

interface DRepCardProps {
  drep: DRepDirectoryEntry;
}

function DRepCard({ drep }: DRepCardProps): React.ReactElement {
  const { t } = useTranslation();
  const { formatLovelace } = useFormatters();
  const power = (() => {
    try {
      return formatLovelace(drep.votingPower);
    } catch {
      return '—';
    }
  })();
  const objectivesPreview = drep.objectives
    ? drep.objectives.replace(/\s+/g, ' ').trim().slice(0, 140)
    : null;
  // Lifecycle status badge — four states. Predefined DReps
  // (drep_always_abstain / drep_always_no_confidence) take priority over
  // the active/inactive/retired axis because they don't sit on that
  // lifecycle at all — they're protocol primitives, not registered
  // DReps. Retired is distinct from inactive (an inactive DRep can still
  // come back; retired filed a retirement certificate and is permanently
  // out).
  const statusBadge = drep.isPredefined ? (
    <StatusPill
      status="voting"
      label={t('drepDirectory.status.predefined')}
      title={t('drepDirectory.status.predefinedTitle')}
    />
  ) : drep.isRetired ? (
    <StatusPill
      status="neutral"
      label={t('drepDirectory.status.retired')}
      title={t('drepDirectory.status.retiredTitle')}
    />
  ) : drep.isActive ? (
    <StatusPill status="active" label={t('drepDirectory.status.active')} />
  ) : (
    <StatusPill
      status="expired"
      label={
        drep.expiresEpoch !== null
          ? t('drepDirectory.status.inactiveExpires', { epoch: drep.expiresEpoch })
          : t('drepDirectory.status.inactive')
      }
      title={t('drepDirectory.status.inactiveTitle')}
    />
  );
  return (
    <Link
      to={`/drep/${encodeURIComponent(drep.drepId)}`}
      className={cn(
        'block bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl shadow-token-sm p-5',
        'transition-all duration-150',
        'hover:border-[var(--border-strong)] hover:shadow-token-md hover:-translate-y-px',
        // Slight muting for inactive / retired DReps so the active set
        // stays visually dominant when the toggle is on.
        (!drep.isActive || drep.isRetired) && 'opacity-80',
      )}
    >
      <div className="flex items-start gap-4">
        <DRepAvatar
          drepId={drep.drepId}
          name={drep.givenName}
          imageContentHash={drep.imageContentHash}
          size={52}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            {drep.givenName ? (
              <h3
                className={cn(
                  'font-semibold text-[15px] text-[var(--text-primary)] tracking-tight truncate',
                  // Predefined DRep names are hard-coded by the sync
                  // (not authored by the DRep) — italicize so the user
                  // sees at a glance that this isn't a self-attested
                  // CIP-119 givenName.
                  drep.isPredefined && 'italic',
                )}
              >
                {drep.givenName}
              </h3>
            ) : (
              <h3 className="text-[14px] italic text-[var(--text-tertiary)] truncate">
                {t('drepDirectory.unnamed')}
              </h3>
            )}
            {statusBadge}
            {drep.hasScript && (
              <StatusPill
                status="neutral"
                label={t('drepDirectory.status.script')}
                title={t('drepDirectory.status.scriptTitle')}
              />
            )}
          </div>
          <div className="text-[11px] font-mono text-[var(--text-muted)] mb-1.5 truncate">
            {shortDRepId(drep.drepId)}
          </div>
          <div className="flex items-center gap-4 text-[12px] text-[var(--text-secondary)] tabular-nums flex-wrap">
            <span>
              <span className="text-[var(--text-tertiary)]">{t('drepDirectory.powerLabel')}</span>
              <span className="font-semibold text-[var(--text-primary)]">{power}</span>
            </span>
            {typeof drep.delegatorCount === 'number' && (
              <span className="inline-flex items-center gap-1">
                <UsersIcon size={11} strokeWidth={2} aria-hidden="true" />
                {drep.delegatorCount.toLocaleString()}
              </span>
            )}
            <LastVotedTag
              lastVotedAt={drep.lastVotedAt}
              voteCount={drep.voteCount}
            />
          </div>
          {objectivesPreview && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)] line-clamp-2">
              {objectivesPreview}
              {drep.objectives && drep.objectives.length > objectivesPreview.length ? '…' : ''}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

function parseSort(raw: string | null): SortKey {
  if (raw === 'delegators' || raw === 'recent' || raw === 'name') return raw;
  return 'power';
}

/** Coerce the URL `?pageSize=` to one of the allowed values. Anything
 *  else falls back to the default — keeps the URL self-correcting if a
 *  user pastes a stale link. */
function parsePageSize(raw: string | null): PageSize {
  const n = raw ? parseInt(raw, 10) : NaN;
  return PAGE_SIZE_OPTIONS.find((s) => s === n) ?? DEFAULT_PAGE_SIZE;
}

/** 0-indexed page parsed from the URL's 1-indexed `?page=` param. */
function parsePage(raw: string | null): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n - 1;
}

/**
 * Compute the windowed list of page numbers to render. Standard pattern:
 * always show page 1 and the last page; show current ± 2; insert "…"
 * gaps where there are skips. For small totalPages we just enumerate
 * everything.
 *
 * Returns an array of `number` (page numbers, 0-indexed) and `'…'`
 * sentinels for ellipsis breaks.
 */
function paginationWindow(currentPage: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 1) return [0];
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  const window = new Set<number>([0, totalPages - 1, currentPage]);
  for (let off = -2; off <= 2; off++) {
    const p = currentPage + off;
    if (p >= 0 && p < totalPages) window.add(p);
  }
  const sorted = Array.from(window).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (i > 0) {
      const prev = sorted[i - 1]!;
      if (cur - prev > 1) out.push('…');
    }
    out.push(cur);
  }
  return out;
}

interface ListPage {
  items: DRepDirectoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function DRepDirectoryPage(): React.ReactElement {
  const { t } = useTranslation();
  // URL-backed state so toolbar, search, sort, page and page-size all
  // survive reloads and are deep-linkable. The URL stores 1-indexed
  // pages (more familiar to users) but we work with 0-indexed internally
  // to match the backend.
  const [searchParams, setSearchParams] = useSearchParams();
  const includeInactive = searchParams.get('includeInactive') === '1';
  const sort = parseSort(searchParams.get('sort'));
  const pageSize = parsePageSize(searchParams.get('pageSize'));
  const page = parsePage(searchParams.get('page'));

  // Search is debounced via local state; the URL only stores the final
  // committed value (?q=...) so we don't update the URL on every keystroke.
  const [searchInput, setSearchInput] = useState<string>(searchParams.get('q') ?? '');
  const search = useDebounced(searchInput.trim(), 250);

  // Mirror the debounced search into the URL — replace, not push, so the
  // browser back-stack doesn't fill with intermediate values. Searching
  // also resets to page 1.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only run on debounced search change; adding `searchParams`/`setSearchParams` causes an update loop
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const prevSearch = next.get('q') ?? '';
    if (search) next.set('q', search);
    else next.delete('q');
    if (prevSearch !== search) {
      // Search changed — reset to page 1 so the user lands on the top of
      // the new result set rather than a stale page index.
      next.delete('page');
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const setSort = (next: SortKey): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 'power') params.delete('sort');
    else params.set('sort', next);
    // Sort change → reset to page 1 (same logic as search).
    params.delete('page');
    setSearchParams(params, { replace: false });
  };

  const setIncludeInactive = (next: boolean): void => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('includeInactive', '1');
    else params.delete('includeInactive');
    params.delete('page');
    setSearchParams(params, { replace: false });
  };

  const setPageSize = (next: PageSize): void => {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_PAGE_SIZE) params.delete('pageSize');
    else params.set('pageSize', String(next));
    // Resizing the page changes which items appear at any index, so
    // pinning the current page number would dump the user somewhere
    // arbitrary. Reset to page 1.
    params.delete('page');
    setSearchParams(params, { replace: false });
  };

  /** Set the URL `?page=` (1-indexed). Page 1 is the default and writes
   *  no parameter so the URL stays clean. */
  const setPage = (zeroIndexed: number): void => {
    const params = new URLSearchParams(searchParams);
    if (zeroIndexed <= 0) params.delete('page');
    else params.set('page', String(zeroIndexed + 1));
    setSearchParams(params, { replace: false });
  };

  const queryKey = [
    'drep-directory',
    { search, sort, pageSize, includeInactive, page },
  ] as const;

  const { data, isLoading, error, isFetching } = useQuery<ListPage, Error>({
    queryKey,
    queryFn: async (): Promise<ListPage> => {
      const params: Record<string, string> = {
        sort,
        pageSize: String(pageSize),
        page: String(page),
      };
      if (search) params['search'] = search;
      if (includeInactive) params['includeInactive'] = 'true';
      const res = await get<PaginatedResponse<DRepDirectoryEntry>>('/dreps', params);
      // The migrated backend always returns the page-numbered fields.
      // Falling back conservatively keeps us tolerant of a stale Lambda
      // during a deploy window.
      return {
        items: res.items,
        total: res.total ?? res.items.length,
        page: res.page ?? page,
        pageSize: res.pageSize ?? pageSize,
        totalPages: res.totalPages ?? Math.max(1, Math.ceil((res.total ?? res.items.length) / pageSize)),
      };
    },
    placeholderData: keepPreviousData,
  });

  const dreps = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  // Voting-power concentration donut data (Sprint 5). Fetched independently
  // of the directory list — the donut surfaces global concentration math
  // (smallest coalition to cross 60/67/75% thresholds) that doesn't depend
  // on the current page/sort/search, so it doesn't refetch on toolbar
  // changes. Failures are silent — the donut just doesn't render.
  const concentrationQuery = useDrepConcentration();
  // Server clamps page to valid range; mirror that here so the UI
  // doesn't render stale highlights.
  const effectivePage = data?.page ?? page;

  const startIndex = total === 0 ? 0 : effectivePage * pageSize + 1;
  const endIndex = Math.min(total, (effectivePage + 1) * pageSize);

  // Keyboard navigation: when the page-numbers nav is focused, ←/→
  // arrows step pages. Doesn't conflict with global shortcuts because
  // we only handle the keys when our nav element is the keyboard target.
  const navRef = useRef<HTMLElement | null>(null);
  const onNavKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'ArrowLeft' && effectivePage > 0) {
      e.preventDefault();
      setPage(effectivePage - 1);
    } else if (e.key === 'ArrowRight' && effectivePage < totalPages - 1) {
      e.preventDefault();
      setPage(effectivePage + 1);
    } else if (e.key === 'Home' && effectivePage > 0) {
      e.preventDefault();
      setPage(0);
    } else if (e.key === 'End' && effectivePage < totalPages - 1) {
      e.preventDefault();
      setPage(totalPages - 1);
    }
  };

  const window = paginationWindow(effectivePage, totalPages);

  // Plural-aware count label so "1 active DRep" doesn't read awkwardly.
  // i18next selects the _one / _other variant from `count`; ja has only _other.
  const counterLabel =
    total === 0
      ? includeInactive
        ? t('drepDirectory.countDRep', { count: 0 })
        : t('drepDirectory.countActiveDRep', { count: 0 })
      : includeInactive
        ? t('drepDirectory.showingAll', {
            count: total,
            start: startIndex.toLocaleString(),
            end: endIndex.toLocaleString(),
            total: total.toLocaleString(),
          })
        : t('drepDirectory.showingActive', {
            count: total,
            start: startIndex.toLocaleString(),
            end: endIndex.toLocaleString(),
            total: total.toLocaleString(),
          });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-[26px] font-bold tracking-tight text-[var(--text-primary)]">
          {t('drepDirectory.title')}
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          {t('drepDirectory.subtitle')}
          {/* Cadence is set in infra/lib/scheduler-stack.ts; bumped from 5min
              to 30min as part of an emergency WCU-leak fix (commit f6acb024).
              Keep this string in sync with that schedule — it's the only
              user-visible signal of the directory's freshness. */}
          {' '}{t('drepDirectory.syncedNote')}
        </p>
      </header>

      {/* Sprint 5 — voting-power concentration donut. Hidden until the
          backend response lands; failures are silent (the donut is
          informational, not load-bearing). */}
      {concentrationQuery.data && concentrationQuery.data.concentration.drepCount > 0 && (
        <DrepConcentration
          topK={concentrationQuery.data.concentration.topK}
          byPercent={concentrationQuery.data.concentration.byPercent}
          drepCount={concentrationQuery.data.concentration.drepCount}
          totalLabel={concentrationQuery.data.concentration.totalLabel}
          markers={concentrationQuery.data.markers}
          defaultThresholdPct={concentrationQuery.data.defaultThresholdPct}
          thresholdsAsOf={concentrationQuery.data.thresholdsAsOf}
        />
      )}

      {/* Toolbar — search + sort + page-size */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('drepDirectory.searchPlaceholder')}
            aria-label={t('drepDirectory.searchAriaLabel')}
            className={cn(
              'w-full h-[38px] pl-9 pr-3 rounded-token-md text-[13.5px]',
              'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
              'text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]',
              'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
            )}
          />
        </div>
        <div role="tablist" className="tabs flex-shrink-0" aria-label={t('drepDirectory.sortAriaLabel')}>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={sort === opt.id}
              onClick={() => setSort(opt.id)}
              className={cn('tab', sort === opt.id && 'tab--active')}
            >
              {t(`drepDirectory.sort.${opt.id}`)}
            </button>
          ))}
        </div>
        <label
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]"
          title={t('drepDirectory.itemsPerPage')}
        >
          <span className="hidden sm:inline">{t('drepDirectory.perPage')}</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(parsePageSize(e.target.value))}
            className={cn(
              'h-[30px] px-2 rounded-token-md text-[12.5px] tabular-nums',
              'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
              'text-[var(--text-primary)]',
              'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
            )}
            aria-label={t('drepDirectory.itemsPerPage')}
          >
            {PAGE_SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Counter + Active/Inactive toggle. */}
      <div className="flex items-center justify-between text-[12.5px] text-[var(--text-secondary)]">
        <span aria-live="polite" className="tabular-nums">
          {!isLoading && counterLabel}
        </span>
        <label
          className="inline-flex items-center gap-2 cursor-pointer select-none"
          title={t('drepDirectory.showInactiveTitle')}
        >
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--brand-primary)] cursor-pointer"
            aria-label={t('drepDirectory.includeInactiveAriaLabel')}
          />
          <span>{t('drepDirectory.showInactive')}</span>
        </label>
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] shadow-token-sm p-5 animate-pulse"
            >
              <div className="flex items-start gap-4">
                <div className="w-[52px] h-[52px] rounded-token-full bg-[var(--bg-muted)]" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-[var(--bg-muted)] rounded w-1/3" />
                  <div className="h-3 bg-[var(--bg-muted)] rounded w-1/2" />
                  <div className="h-3 bg-[var(--bg-muted)] rounded w-3/4" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-token-lg border border-[var(--danger)]/40 bg-[var(--danger-soft)] p-4 text-sm">
          <p className="font-semibold text-[var(--danger)]">{t('drepDirectory.loadFailed')}</p>
          <p className="text-[var(--text-secondary)] mt-1">{error.message}</p>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !error && dreps.length === 0 && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          {search ? (
            <p>{t('drepDirectory.emptySearch', { search })}</p>
          ) : (
            <p>{t('drepDirectory.emptyNoSync')}</p>
          )}
        </div>
      )}

      {/* Results */}
      {dreps.length > 0 && (
        <ul
          className={cn(
            'space-y-3',
            // Slight visual cue while a paginated request is in flight,
            // since `keepPreviousData` shows the previous page until the
            // new one arrives.
            isFetching && 'opacity-80 transition-opacity',
          )}
        >
          {dreps.map((drep) => (
            <li key={drep.drepId}>
              <DRepCard drep={drep} />
            </li>
          ))}
        </ul>
      )}

      {/* Page-numbered pagination footer */}
      {totalPages > 1 && (
        <nav
          ref={navRef}
          aria-label={t('drepDirectory.pagination.navAriaLabel')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: nav handles arrow-key navigation between pagination buttons; it must be focusable
          tabIndex={0}
          onKeyDown={onNavKeyDown}
          className={cn(
            'flex items-center justify-center gap-1 pt-4',
            'focus:outline-none focus-within:outline-none',
            'rounded-token-md',
          )}
        >
          <button
            type="button"
            onClick={() => setPage(effectivePage - 1)}
            disabled={effectivePage === 0}
            aria-label={t('drepDirectory.pagination.previous')}
            className={cn(
              'inline-flex items-center justify-center h-8 px-2 rounded-token-md',
              'text-[12.5px] text-[var(--text-secondary)]',
              'border border-[var(--border-default)] bg-[var(--bg-canvas)]',
              'hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--border-default)] disabled:hover:text-[var(--text-secondary)]',
              'transition-colors',
            )}
          >
            <ChevronLeftIcon size={14} strokeWidth={2} aria-hidden="true" />
            <span className="ml-1 hidden sm:inline">{t('drepDirectory.pagination.back')}</span>
          </button>
          {window.map((entry, idx) => {
            if (entry === '…') {
              return (
                <span
                  key={`gap-${idx}`}
                  aria-hidden="true"
                  className="px-1 text-[var(--text-tertiary)] text-[12.5px]"
                >
                  …
                </span>
              );
            }
            const isCurrent = entry === effectivePage;
            return (
              <button
                key={entry}
                type="button"
                onClick={() => setPage(entry)}
                aria-current={isCurrent ? 'page' : undefined}
                aria-label={t('drepDirectory.pagination.pageLabel', { page: entry + 1 })}
                className={cn(
                  'inline-flex items-center justify-center min-w-[32px] h-8 px-2 rounded-token-md',
                  'text-[12.5px] tabular-nums',
                  'border transition-colors',
                  isCurrent
                    ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-[var(--bg-canvas)] font-semibold'
                    : 'border-[var(--border-default)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
                )}
              >
                {entry + 1}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setPage(effectivePage + 1)}
            disabled={effectivePage >= totalPages - 1}
            aria-label={t('drepDirectory.pagination.next')}
            className={cn(
              'inline-flex items-center justify-center h-8 px-2 rounded-token-md',
              'text-[12.5px] text-[var(--text-secondary)]',
              'border border-[var(--border-default)] bg-[var(--bg-canvas)]',
              'hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--border-default)] disabled:hover:text-[var(--text-secondary)]',
              'transition-colors',
            )}
          >
            <span className="mr-1 hidden sm:inline">{t('drepDirectory.pagination.nextLabel')}</span>
            <ChevronRightIcon size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}
