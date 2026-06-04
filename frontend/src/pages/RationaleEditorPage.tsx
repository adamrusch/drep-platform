import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
import { useIpfsKeyStatus, useStoreIpfsKey } from '@/hooks/useCommitteeMembership';

const HEARTBEAT_MS = 4 * 60 * 1000; // well under the 20-min lock TTL
const inputCls =
  'w-full rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-[13px] focus:outline-none focus-visible:shadow-token-focus';

export function RationaleEditorPage(): React.ReactElement {
  const { t } = useTranslation();
  const { drepId = '', actionId = '' } = useParams<{ drepId: string; actionId: string }>();
  const { data, isLoading } = useRationale(drepId, actionId);

  const edit = useEditRationale(drepId, actionId);
  const acquire = useAcquireRationaleLock(drepId, actionId);
  const heartbeat = useHeartbeatRationaleLock(drepId, actionId);
  const release = useReleaseRationaleLock(drepId, actionId);
  const finalize = useFinalizeRationale(drepId, actionId);
  const pin = usePinRationale(drepId, actionId);
  const ipfsKeyStatus = useIpfsKeyStatus(drepId);
  const storeKey = useStoreIpfsKey(drepId);

  const [statement, setStatement] = useState('');
  const [summary, setSummary] = useState('');
  // Inline Blockfrost-key setup at pin time (only when no key is stored).
  const [ipfsKeyInput, setIpfsKeyInput] = useState('');
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

  if (isLoading) return <p className="text-[var(--text-secondary)]">{t('rationaleEditor.loading')}</p>;

  const save = (): void => {
    edit.mutate({
      rationaleStatement: statement,
      summary: summary || undefined,
      expectedUpdatedAt: data?.draft?.updatedAt,
    });
  };

  const keyStored = ipfsKeyStatus.data?.stored === true;
  const pinBusy = storeKey.isPending || pin.isPending;

  // Save the Blockfrost key to the committee (persisted, encrypted), then pin
  // with the now-stored key. Keeping it per-committee means the lead does this
  // once; every later pin is a single click.
  const saveKeyAndPin = (): void => {
    const key = ipfsKeyInput.trim();
    if (!key) return;
    storeKey.mutate(
      { ipfsProjectId: key },
      {
        onSuccess: () => {
          setIpfsKeyInput('');
          pin.mutate({});
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <Link to={`/committee/${encodeURIComponent(drepId)}/votes/${encodeURIComponent(actionId)}`} className="text-[13px] text-[var(--brand-primary)] hover:underline">
        {t('rationaleEditor.backToVote')}
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>{t('rationaleEditor.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <StatusPill status="review" label={t('rationaleEditor.mode', { mode })} />
            {data?.final && <StatusPill status="passed" label={t('rationaleEditor.finalized')} />}
            {collaborative && lockedByOther && (
              <span className="text-[var(--danger)]">
                {t('rationaleEditor.editingNow', { editor: data?.lock?.editorWallet?.slice(0, 12) })}
              </span>
            )}
          </div>

          {collaborative && !holdsLock && !data?.final && (
            <Button size="sm" variant="secondary" disabled={lockedByOther || acquire.isPending} onClick={() => acquire.mutate()}>
              {acquire.isPending ? t('rationaleEditor.opening') : lockedByOther ? t('rationaleEditor.lockedByAnother') : t('rationaleEditor.openForEditing')}
            </Button>
          )}

          <label className="block text-[12px] text-[var(--text-secondary)]">
            {t('rationaleEditor.summary')}
            <input className={`${inputCls} mt-1`} value={summary} disabled={!canEdit || Boolean(data?.final)} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="block text-[12px] text-[var(--text-secondary)]">
            {t('rationaleEditor.statement')}
            <textarea className={`${inputCls} mt-1 min-h-[200px] resize-y`} value={statement} disabled={!canEdit || Boolean(data?.final)} onChange={(e) => setStatement(e.target.value)} />
          </label>
          <p className="text-[11.5px] text-[var(--text-secondary)]">{t('rationaleEditor.charCount', { count: statement.length })}</p>

          {!data?.final && (
            <Button size="sm" variant="primary" disabled={!canEdit || !statement.trim() || edit.isPending} onClick={save}>
              {edit.isPending ? t('rationaleEditor.saving') : collaborative ? t('rationaleEditor.saveAndRelease') : t('rationaleEditor.save')}
            </Button>
          )}
          {edit.isError && <p className="text-[12px] text-[var(--danger)]">{(edit.error as Error)?.message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('rationaleEditor.finalizeAndPin')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {data?.final ? (
            <div className="space-y-2 text-[12.5px]">
              <div className="break-all"><span className="text-[var(--text-secondary)]">{t('rationaleEditor.anchorHash')}</span> <span className="font-mono">{data.final.anchorHash}</span></div>
              {data.final.ipfsUri ? (
                <div className="break-all"><span className="text-[var(--text-secondary)]">{t('rationaleEditor.ipfs')}</span> <span className="font-mono">{data.final.ipfsUri}</span></div>
              ) : keyStored ? (
                /* A key is already stored for this committee — one-click pin. */
                <Button size="sm" variant="secondary" disabled={pinBusy} onClick={() => pin.mutate({})}>
                  {pin.isPending ? t('rationaleEditor.pinning') : t('rationaleEditor.pinToIpfs')}
                </Button>
              ) : (
                /* No key stored — ask the committee to add a Blockfrost key. */
                <div className="space-y-2 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-muted)] p-3">
                  <h4 className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    {t('rationaleEditor.ipfsKeyRequired')}
                  </h4>
                  <p className="text-[11.5px] text-[var(--text-secondary)]">
                    {t('rationaleEditor.ipfsKeyPromptBody')}
                  </p>
                  <a
                    href="https://blockfrost.io"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-[11.5px] text-[var(--brand-primary)] hover:underline"
                  >
                    {t('rationaleEditor.ipfsKeyGetLink')}
                  </a>
                  <input
                    type="password"
                    value={ipfsKeyInput}
                    onChange={(e) => setIpfsKeyInput(e.target.value)}
                    placeholder={t('rationaleEditor.ipfsKeyPlaceholder')}
                    autoComplete="off"
                    className={inputCls}
                  />
                  <Button size="sm" variant="primary" disabled={!ipfsKeyInput.trim() || pinBusy} onClick={saveKeyAndPin}>
                    {pinBusy ? t('rationaleEditor.ipfsKeySaving') : t('rationaleEditor.ipfsKeySaveAndPin')}
                  </Button>
                  <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('rationaleEditor.ipfsKeySettingsHint')}
                  </p>
                </div>
              )}
              {storeKey.isError && (
                <p className="text-[12px] text-[var(--danger)]">
                  {t('rationaleEditor.ipfsKeyErrorPrefix')} {(storeKey.error as Error)?.message}
                </p>
              )}
              {pin.isError && (
                <p className="text-[12px] text-[var(--danger)]">
                  {t('rationaleEditor.pinErrorPrefix')} {(pin.error as Error)?.message}
                </p>
              )}
            </div>
          ) : (
            <>
              <p className="text-[12.5px] text-[var(--text-secondary)]">
                {t('rationaleEditor.finalizeHelp')}
              </p>
              <Button size="sm" variant="primary" disabled={finalize.isPending} onClick={() => finalize.mutate()}>
                {finalize.isPending ? t('rationaleEditor.signing') : t('rationaleEditor.finalize')}
              </Button>
              {finalize.isError && <p className="text-[12px] text-[var(--danger)]">{(finalize.error as Error)?.message}</p>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
