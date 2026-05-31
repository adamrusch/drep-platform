import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import {
  useRationale,
  useEditRationale,
  useAcquireRationaleLock,
  useHeartbeatRationaleLock,
  useReleaseRationaleLock,
  useFinalizeRationale,
  usePinRationale,
} from '@/hooks/useCommitteeRationale';

const HEARTBEAT_MS = 4 * 60 * 1000; // well under the 20-min lock TTL
const inputCls =
  'w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-[13px] focus:outline-none focus-visible:shadow-token-focus';

export function RationaleEditorPage(): React.ReactElement {
  const { drepId = '', actionId = '' } = useParams<{ drepId: string; actionId: string }>();
  const { data, isLoading } = useRationale(drepId, actionId);

  const edit = useEditRationale(drepId, actionId);
  const acquire = useAcquireRationaleLock(drepId, actionId);
  const heartbeat = useHeartbeatRationaleLock(drepId, actionId);
  const release = useReleaseRationaleLock(drepId, actionId);
  const finalize = useFinalizeRationale(drepId, actionId);
  const pin = usePinRationale(drepId, actionId);

  const [statement, setStatement] = useState('');
  const [summary, setSummary] = useState('');
  const loadedFor = useRef<string | null>(null);

  // Hydrate the form from the loaded draft (once per draft version).
  useEffect(() => {
    if (data?.draft && loadedFor.current !== data.draft.updatedAt) {
      setStatement(data.draft.rationaleStatement ?? '');
      setSummary(data.draft.summary ?? '');
      loadedFor.current = data.draft.updatedAt;
    }
  }, [data?.draft]);

  const mode = data?.mode ?? 'lead';
  const collaborative = mode === 'collaborative';
  const holdsLock = Boolean(data?.lock?.heldByMe);
  const lockedByOther = Boolean(data?.lock && !data.lock.heldByMe);
  const canEdit = !collaborative || holdsLock;

  // Heartbeat + release lifecycle while holding a collaborative lock.
  useEffect(() => {
    if (!collaborative || !holdsLock) return;
    const id = setInterval(() => heartbeat.mutate(), HEARTBEAT_MS);
    return () => {
      clearInterval(id);
      release.mutate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collaborative, holdsLock]);

  if (isLoading) return <p className="text-[var(--text-secondary)]">Loading rationale…</p>;

  const save = (): void => {
    edit.mutate({
      rationaleStatement: statement,
      summary: summary || undefined,
      expectedUpdatedAt: data?.draft?.updatedAt,
    });
  };

  return (
    <div className="space-y-4">
      <Link to={`/committee/${encodeURIComponent(drepId)}/votes/${encodeURIComponent(actionId)}`} className="text-[13px] text-[var(--brand-primary)] hover:underline">
        ← Back to vote
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Rationale</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <StatusPill status="review" label={`Mode: ${mode}`} />
            {data?.final && <StatusPill status="passed" label="Finalized" />}
            {collaborative && lockedByOther && (
              <span className="text-[var(--danger)]">
                {data?.lock?.editorWallet?.slice(0, 12)}… is editing now
              </span>
            )}
          </div>

          {collaborative && !holdsLock && !data?.final && (
            <Button size="sm" variant="secondary" disabled={lockedByOther || acquire.isPending} onClick={() => acquire.mutate()}>
              {acquire.isPending ? 'Opening…' : lockedByOther ? 'Locked by another editor' : 'Open for editing'}
            </Button>
          )}

          <label className="block text-[12px] text-[var(--text-secondary)]">
            Summary
            <input className={`${inputCls} mt-1`} value={summary} disabled={!canEdit || Boolean(data?.final)} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="block text-[12px] text-[var(--text-secondary)]">
            Rationale statement
            <textarea className={`${inputCls} mt-1 min-h-[200px] resize-y`} value={statement} disabled={!canEdit || Boolean(data?.final)} onChange={(e) => setStatement(e.target.value)} />
          </label>
          <p className="text-[11.5px] text-[var(--text-secondary)]">{statement.length} chars (60 KB cap)</p>

          {!data?.final && (
            <Button size="sm" variant="primary" disabled={!canEdit || !statement.trim() || edit.isPending} onClick={save}>
              {edit.isPending ? 'Saving…' : collaborative ? 'Save & release lock' : 'Save'}
            </Button>
          )}
          {edit.isError && <p className="text-[12px] text-[var(--danger)]">{(edit.error as Error)?.message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Finalize & pin</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {data?.final ? (
            <div className="space-y-1 text-[12.5px]">
              <div className="break-all"><span className="text-[var(--text-secondary)]">anchor hash:</span> <span className="font-mono">{data.final.anchorHash}</span></div>
              {data.final.ipfsUri ? (
                <div className="break-all"><span className="text-[var(--text-secondary)]">IPFS:</span> <span className="font-mono">{data.final.ipfsUri}</span></div>
              ) : (
                <Button size="sm" variant="secondary" disabled={pin.isPending} onClick={() => pin.mutate({})}>
                  {pin.isPending ? 'Pinning…' : 'Pin to IPFS'}
                </Button>
              )}
            </div>
          ) : (
            <>
              <p className="text-[12.5px] text-[var(--text-secondary)]">
                Finalizing locks the rationale and computes its anchor hash. Required before the on-chain vote. Lead or proposer only.
              </p>
              <Button size="sm" variant="primary" disabled={finalize.isPending} onClick={() => finalize.mutate()}>
                {finalize.isPending ? 'Signing…' : 'Finalize rationale'}
              </Button>
              {finalize.isError && <p className="text-[12px] text-[var(--danger)]">{(finalize.error as Error)?.message}</p>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
