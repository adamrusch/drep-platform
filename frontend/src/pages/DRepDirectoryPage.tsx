import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { cn, formatLovelace, formatRelativeTime } from '@/lib/utils';
import type { DRepDirectoryEntry, PaginatedResponse } from '@/types';

type SortKey = 'power' | 'delegators' | 'recent' | 'name';

const SORT_OPTIONS: Array<{ id: SortKey; label: string }> = [
  { id: 'name', label: 'Name' },
  { id: 'power', label: 'Voting power' },
  { id: 'recent', label: 'Last voted' },
  { id: 'delegators', label: 'Delegators' },
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
  imageUrl?: string;
  size?: number;
}

function DRepAvatar({ drepId, name, imageUrl, size = 48 }: AvatarProps): React.ReactElement {
  const [errored, setErrored] = useState(false);
  // Per the punt protocol — flaky CIP-119 image URLs (404s, mixed-content,
  // CORS) are a known headache. We attempt the image but transparently
  // fall back to the initial-letter avatar on any error.
  const initial = useMemo(() => {
    const source = name?.trim() ?? '';
    if (source.length > 0) return source[0]!.toUpperCase();
    // Fall back to the first non-prefix character of the DRep ID so each
    // anchor-less DRep gets a stable letter rather than all 'd'.
    return drepId.startsWith('drep1') ? drepId[5]?.toUpperCase() ?? 'D' : 'D';
  }, [name, drepId]);
  const showImage =
    !errored &&
    typeof imageUrl === 'string' &&
    /^https?:\/\//i.test(imageUrl); // skip ipfs/data: in v1 — flaky
  return (
    <div
      className="flex-shrink-0 inline-flex items-center justify-center font-semibold rounded-token-full overflow-hidden"
      style={{
        width: size,
        height: size,
        background: showImage ? 'transparent' : avatarColor(drepId),
        color: '#0d1b1f',
        fontSize: Math.round(size * 0.42),
      }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={imageUrl}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setErrored(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <span>{initial}</span>
      )}
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
  if (!lastVotedAt) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[var(--text-tertiary)]"
        title="This DRep has never cast a vote"
      >
        <VoteIcon size={11} strokeWidth={2} aria-hidden="true" />
        Never voted
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
      ? `${voteCount.toLocaleString()} votes • last vote ${new Date(lastVotedAt).toLocaleString()}`
      : `Last voted ${new Date(lastVotedAt).toLocaleString()}`;
  return (
    <span
      className={cn('inline-flex items-center gap-1 tabular-nums', colorClass)}
      title={tooltip}
    >
      <VoteIcon size={11} strokeWidth={2} aria-hidden="true" />
      Voted {formatRelativeTime(lastVotedAt)}
    </span>
  );
}

interface DRepCardProps {
  drep: DRepDirectoryEntry;
}

function DRepCard({ drep }: DRepCardProps): React.ReactElement {
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
      label="Predefined"
      title="A built-in Cardano DRep used for auto-vote delegations. These pseudo-identities are not registered like normal DReps but hold significant voting power."
    />
  ) : drep.isRetired ? (
    <StatusPill
      status="neutral"
      label="Retired"
      title="This DRep has filed a retirement certificate. They cannot vote and their voting power is zero."
    />
  ) : drep.isActive ? (
    <StatusPill status="active" label="Active" />
  ) : (
    <StatusPill
      status="expired"
      label={
        drep.expiresEpoch !== null
          ? `Inactive · expires E${drep.expiresEpoch}`
          : 'Inactive'
      }
      title="No vote in the last drepActivity epochs (~100 days). Voting power is excluded from the active stake denominator until they vote again."
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
          imageUrl={drep.image}
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
                (Unnamed DRep)
              </h3>
            )}
            {statusBadge}
            {drep.hasScript && (
              <StatusPill
                status="neutral"
                label="Script"
                title="Script-controlled DRep"
              />
            )}
          </div>
          <div className="text-[11px] font-mono text-[var(--text-muted)] mb-1.5 truncate">
            {shortDRepId(drep.drepId)}
          </div>
          <div className="flex items-center gap-4 text-[12px] text-[var(--text-secondary)] tabular-nums flex-wrap">
            <span>
              <span className="text-[var(--text-tertiary)]">Power: </span>
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
  const noun = includeInactive ? 'DRep' : 'active DRep';
  const counterLabel =
    total === 0
      ? `No ${noun}s`
      : `Showing ${startIndex.toLocaleString()}–${endIndex.toLocaleString()} of ${total.toLocaleString()} ${noun}${total === 1 ? '' : 's'}`;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-[26px] font-bold tracking-tight text-[var(--text-primary)]">
          DReps
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Every registered Cardano DRep, with bios from their CIP-119 anchor metadata.
          {/* Cadence is set in infra/lib/scheduler-stack.ts; bumped from 5min
              to 30min as part of an emergency WCU-leak fix (commit f6acb024).
              Keep this string in sync with that schedule — it's the only
              user-visible signal of the directory's freshness. */}
          {' '}Synced from Koios every 30 minutes.
        </p>
      </header>

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
            placeholder="Search DRep names…"
            aria-label="Search DReps by name"
            className={cn(
              'w-full h-[38px] pl-9 pr-3 rounded-token-md text-[13.5px]',
              'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
              'text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]',
              'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
            )}
          />
        </div>
        <div role="tablist" className="tabs flex-shrink-0" aria-label="Sort DReps">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              role="tab"
              aria-selected={sort === opt.id}
              onClick={() => setSort(opt.id)}
              className={cn('tab', sort === opt.id && 'tab--active')}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <label
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]"
          title="Items per page"
        >
          <span className="hidden sm:inline">Per page:</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(parsePageSize(e.target.value))}
            className={cn(
              'h-[30px] px-2 rounded-token-md text-[12.5px] tabular-nums',
              'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
              'text-[var(--text-primary)]',
              'focus:outline-none focus:border-[var(--brand-primary)] focus:shadow-token-focus',
            )}
            aria-label="Items per page"
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
          title="Inactive DReps haven't voted in ~100 days; retired DReps have filed a retirement certificate. Voting power for both is excluded from the active stake denominator."
        >
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--brand-primary)] cursor-pointer"
            aria-label="Include inactive and retired DReps"
          />
          <span>Show inactive &amp; retired</span>
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
          <p className="font-semibold text-[var(--danger)]">Failed to load DReps</p>
          <p className="text-[var(--text-secondary)] mt-1">{error.message}</p>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !error && dreps.length === 0 && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          {search ? (
            <p>No DReps matched "{search}".</p>
          ) : (
            <p>No DReps found. The directory may still be syncing — check back shortly.</p>
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
          aria-label="DRep directory pagination"
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
            aria-label="Previous page"
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
            <span className="ml-1 hidden sm:inline">Back</span>
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
                aria-label={`Page ${entry + 1}`}
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
            aria-label="Next page"
            className={cn(
              'inline-flex items-center justify-center h-8 px-2 rounded-token-md',
              'text-[12.5px] text-[var(--text-secondary)]',
              'border border-[var(--border-default)] bg-[var(--bg-canvas)]',
              'hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--border-default)] disabled:hover:text-[var(--text-secondary)]',
              'transition-colors',
            )}
          >
            <span className="mr-1 hidden sm:inline">Next</span>
            <ChevronRightIcon size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}
