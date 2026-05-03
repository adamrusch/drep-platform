import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search as SearchIcon, Users as UsersIcon, Vote as VoteIcon } from 'lucide-react';
import { get } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn, formatLovelace, formatRelativeTime } from '@/lib/utils';
import type { DRepDirectoryEntry, PaginatedResponse } from '@/types';

type SortKey = 'power' | 'delegators' | 'recent';

const SORT_OPTIONS: Array<{ id: SortKey; label: string }> = [
  { id: 'power', label: 'Voting power' },
  { id: 'delegators', label: 'Delegators' },
  { id: 'recent', label: 'Recent activity' },
];

const PAGE_LIMIT = 24;

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
  return (
    <Link
      to={`/drep/${encodeURIComponent(drep.drepId)}`}
      className={cn(
        'block bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl shadow-token-sm p-5',
        'transition-all duration-150',
        'hover:border-[var(--border-strong)] hover:shadow-token-md hover:-translate-y-px',
        // Slight muting for inactive DReps so the active set stays
        // visually dominant when the toggle is on.
        !drep.isActive && 'opacity-80',
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
              <h3 className="font-semibold text-[15px] text-[var(--text-primary)] tracking-tight truncate">
                {drep.givenName}
              </h3>
            ) : (
              <h3 className="text-[14px] italic text-[var(--text-tertiary)] truncate">
                (Unnamed DRep)
              </h3>
            )}
            {drep.isActive ? (
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
            )}
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

interface ListPage {
  items: DRepDirectoryEntry[];
  lastEvaluatedKey?: string;
  total?: number;
}

function parseSort(raw: string | null): SortKey {
  if (raw === 'delegators' || raw === 'recent') return raw;
  return 'power';
}

export function DRepDirectoryPage(): React.ReactElement {
  // URL-backed state so the Inactive toggle, search, and sort survive
  // reloads and are deep-linkable. We update params individually on
  // change to avoid clobbering unrelated keys.
  const [searchParams, setSearchParams] = useSearchParams();
  const includeInactive = searchParams.get('includeInactive') === '1';
  const sort = parseSort(searchParams.get('sort'));

  // Search is debounced via local state; the URL only stores the final
  // committed value (?q=...) so we don't update the URL on every keystroke.
  const [searchInput, setSearchInput] = useState<string>(searchParams.get('q') ?? '');
  const search = useDebounced(searchInput.trim(), 250);

  // Mirror the debounced search into the URL — replace, not push, so the
  // browser back-stack doesn't fill with intermediate values.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (search) next.set('q', search);
    else next.delete('q');
    // Only update if changed to avoid an infinite loop.
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const setSort = (next: SortKey): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 'power') params.delete('sort');
    else params.set('sort', next);
    setSearchParams(params, { replace: false });
  };

  const setIncludeInactive = (next: boolean): void => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('includeInactive', '1');
    else params.delete('includeInactive');
    setSearchParams(params, { replace: false });
  };

  const queryKey = [
    'drep-directory',
    { search, sort, limit: PAGE_LIMIT, includeInactive },
  ] as const;

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<ListPage, Error>({
      queryKey,
      queryFn: async ({ pageParam }): Promise<ListPage> => {
        const params: Record<string, string> = {
          sort,
          limit: String(PAGE_LIMIT),
        };
        if (search) params['search'] = search;
        if (includeInactive) params['includeInactive'] = 'true';
        if (typeof pageParam === 'string' && pageParam.length > 0) {
          params['lastKey'] = pageParam;
        }
        const res = await get<PaginatedResponse<DRepDirectoryEntry>>('/dreps', params);
        return {
          items: res.items,
          lastEvaluatedKey: res.lastEvaluatedKey,
          total: res.total,
        };
      },
      initialPageParam: undefined,
      getNextPageParam: (last) => last.lastEvaluatedKey,
    });

  const dreps = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-[26px] font-bold tracking-tight text-[var(--text-primary)]">
          DReps
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Every registered Cardano DRep, with bios from their CIP-119 anchor metadata.
          Synced from Koios every five minutes.
        </p>
      </header>

      {/* Toolbar — search + sort */}
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
      </div>

      {/* Active/Inactive toggle. Implemented as a plain checkbox-styled
          control with a clear label so it's accessible and keyboard-
          friendly without pulling in a switch component. */}
      <div className="flex items-center justify-between text-[12.5px] text-[var(--text-secondary)]">
        <span>
          {dreps.length > 0 && (data?.pages[0]?.total != null) && (
            <>Showing {dreps.length}{includeInactive ? ' (active + inactive)' : ' active'}</>
          )}
        </span>
        <label
          className="inline-flex items-center gap-2 cursor-pointer select-none"
          title="Inactive DReps are registered but haven't voted in ~100 days. Their voting power is excluded from the active stake denominator until they vote again."
        >
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--brand-primary)] cursor-pointer"
            aria-label="Include inactive DReps"
          />
          <span>Show inactive</span>
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
        <ul className="space-y-3">
          {dreps.map((drep) => (
            <li key={drep.drepId}>
              <DRepCard drep={drep} />
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {hasNextPage && (
        <div className="text-center pt-4">
          <Button
            variant="secondary"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
