// ============================================================
// Per-action-type formatters for the on-chain `governance_description`
// returned by Blockfrost. Produces a one-line `summary` plus a
// structured `details` array that the frontend can render as a
// definition list.
//
// The shape of `governance_description` is documented at
// https://docs.blockfrost.io/#tag/cardano--governance/GET/governance/proposals/%7Btx_hash%7D/%7Bcert_index%7D
// but in practice the field is a serde-style tagged union from
// cardano-ledger; e.g. `{ "tag": "TreasuryWithdrawals", "contents": [...] }`.
// We must defensively handle missing/extra fields — Blockfrost has
// already mutated this shape twice during the Conway era.
// ============================================================

import type { GovernanceActionType } from './types';

// ---- Public types ----

export interface GovernanceDetail {
  label: string;
  value: string;
}

export interface GovernanceSummary {
  summary: string;
  details: GovernanceDetail[];
}

// ---- Helpers ----

/**
 * Format a lovelace string (or number) into a human-readable ada amount
 * with thousands separators, e.g. "39,787,316 ₳".
 */
function formatAda(lovelace: string | number | bigint | undefined | null): string {
  if (lovelace == null) return 'unknown';
  let big: bigint;
  try {
    big = typeof lovelace === 'bigint' ? lovelace : BigInt(String(lovelace));
  } catch {
    return String(lovelace);
  }
  const ada = big / 1_000_000n;
  const remainder = big % 1_000_000n;
  const adaStr = new Intl.NumberFormat('en-US').format(Number(ada));
  if (remainder === 0n) return `${adaStr} ₳`;
  // Up to 6 decimal places, trimmed
  const decimals = remainder.toString().padStart(6, '0').replace(/0+$/, '');
  return decimals.length > 0 ? `${adaStr}.${decimals} ₳` : `${adaStr} ₳`;
}

/** Truncate a long bech32 / hex string to "abcd…wxyz". */
function shortAddress(addr: string): string {
  if (!addr || addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

// ---- Per-type formatters ----

interface RawDescription {
  tag?: string;
  contents?: unknown;
  [k: string]: unknown;
}

function summarizeTreasuryWithdrawals(d: RawDescription): GovernanceSummary {
  // Conway shape:
  //   { tag: "TreasuryWithdrawals",
  //     contents: [ [ [ {network, credential}, lovelace ], ... ], <policyHash | null> ] }
  const contents = Array.isArray(d.contents) ? (d.contents as unknown[]) : [];
  const withdrawalsRaw = Array.isArray(contents[0]) ? (contents[0] as unknown[]) : [];
  const policyHash = asString(contents[1]);

  const items: Array<{ recipient: string; lovelace: bigint }> = [];
  let totalLovelace = 0n;

  for (const entry of withdrawalsRaw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const recip = entry[0] as Record<string, unknown> | undefined;
    const amountRaw = entry[1];
    let amount: bigint | undefined;
    try {
      amount = BigInt(String(amountRaw ?? 0));
    } catch {
      amount = undefined;
    }
    if (amount == null) continue;
    totalLovelace += amount;
    let recipientLabel = 'unknown';
    if (recip && typeof recip === 'object') {
      const cred = recip['credential'] as Record<string, unknown> | undefined;
      if (cred && typeof cred === 'object') {
        const sh = asString(cred['scriptHash']);
        const kh = asString(cred['keyHash']);
        if (sh) recipientLabel = `script ${shortAddress(sh)}`;
        else if (kh) recipientLabel = `key ${shortAddress(kh)}`;
      }
      const stake = asString(recip['stakeAddress']) ?? asString(recip['address']);
      if (stake) recipientLabel = shortAddress(stake);
    }
    items.push({ recipient: recipientLabel, lovelace: amount });
  }

  const details: GovernanceDetail[] = [];
  if (items.length === 0) {
    return {
      summary: 'Treasury withdrawal (recipients unparsed)',
      details: [{ label: 'Note', value: 'On-chain description had no parseable recipients.' }],
    };
  }

  for (const it of items) {
    details.push({ label: `Withdraw to ${it.recipient}`, value: formatAda(it.lovelace) });
  }
  details.push({ label: 'Total', value: formatAda(totalLovelace) });
  if (policyHash) details.push({ label: 'Guard script policy', value: shortAddress(policyHash) });

  let summary: string;
  if (items.length === 1) {
    const only = items[0]!;
    summary = `Withdraw ${formatAda(only.lovelace)} from treasury to ${only.recipient}`;
  } else {
    summary = `Withdraw ${formatAda(totalLovelace)} from treasury to ${items.length} recipients`;
  }
  return { summary, details };
}

function summarizeHardForkInitiation(d: RawDescription): GovernanceSummary {
  const contents = Array.isArray(d.contents) ? (d.contents as unknown[]) : [];
  // contents = [ <prevActionId | null>, { major, minor } ]
  const ver = (contents[1] ?? {}) as Record<string, unknown>;
  const major = asNumber(ver['major']);
  const minor = asNumber(ver['minor']);
  if (major != null && minor != null) {
    return {
      summary: `Hard fork to protocol version ${major}.${minor}`,
      details: [
        { label: 'Major version', value: String(major) },
        { label: 'Minor version', value: String(minor) },
      ],
    };
  }
  return { summary: 'Hard fork initiation (version unparsed)', details: [] };
}

function summarizeParameterChange(d: RawDescription): GovernanceSummary {
  const contents = Array.isArray(d.contents) ? (d.contents as unknown[]) : [];
  // contents = [ <prevActionId|null>, <PParamsUpdate>, <policyHash|null> ]
  const params = (contents[1] ?? {}) as Record<string, unknown>;
  const details: GovernanceDetail[] = [];
  const labelMap: Record<string, string> = {
    minFeeA: 'minFeeA (linear)',
    minFeeB: 'minFeeB (constant)',
    maxBlockSize: 'Max block size',
    maxTxSize: 'Max tx size',
    maxBlockHeaderSize: 'Max block header size',
    keyDeposit: 'Key deposit',
    poolDeposit: 'Pool deposit',
    eMax: 'Pool retirement epoch bound',
    nOpt: 'Optimal pool count',
    a0: 'Pool pledge influence (a0)',
    rho: 'Monetary expansion (rho)',
    tau: 'Treasury expansion (tau)',
    decentralisationParam: 'Decentralisation',
    extraEntropy: 'Extra entropy',
    protocolVersion: 'Protocol version',
    minPoolCost: 'Min pool cost',
    minUtxoValue: 'Min UTXO value',
    coinsPerUtxoByte: 'Coins per UTXO byte',
    costModels: 'Plutus cost models',
    executionUnitPrices: 'Execution unit prices',
    maxTxExecutionUnits: 'Max tx execution units',
    maxBlockExecutionUnits: 'Max block execution units',
    maxValueSize: 'Max value size',
    collateralPercentage: 'Collateral percentage',
    maxCollateralInputs: 'Max collateral inputs',
    poolVotingThresholds: 'SPO voting thresholds',
    dRepVotingThresholds: 'DRep voting thresholds',
    committeeMinSize: 'Committee min size',
    committeeMaxTermLength: 'Committee max term length',
    govActionLifetime: 'Governance action lifetime (epochs)',
    govActionDeposit: 'Governance action deposit',
    dRepDeposit: 'DRep deposit',
    dRepActivity: 'DRep activity',
    minFeeRefScriptCostPerByte: 'Min fee per ref script byte',
  };

  const changedKeys: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (raw == null) continue;
    const label = labelMap[key] ?? key;
    let value: string;
    if (key === 'costModels' && raw && typeof raw === 'object') {
      const versions = Object.keys(raw as Record<string, unknown>);
      value = `updated for ${versions.join(', ')}`;
    } else if (typeof raw === 'object') {
      // Threshold maps, execution unit objects, etc — render compactly
      try {
        const json = JSON.stringify(raw);
        value = json.length > 120 ? `${json.slice(0, 117)}…` : json;
      } catch {
        value = '[object]';
      }
    } else if (typeof raw === 'bigint' || typeof raw === 'number' || typeof raw === 'string') {
      // Lovelace-shaped fields → render as ada
      const lovelaceFields = new Set([
        'keyDeposit',
        'poolDeposit',
        'minPoolCost',
        'minUtxoValue',
        'govActionDeposit',
        'dRepDeposit',
        'coinsPerUtxoByte',
      ]);
      if (lovelaceFields.has(key)) {
        value = formatAda(raw as string | number | bigint);
      } else {
        value = String(raw);
      }
    } else {
      value = String(raw);
    }
    details.push({ label, value });
    changedKeys.push(label);
  }

  if (changedKeys.length === 0) {
    return { summary: 'Protocol parameter change (no parameters listed)', details: [] };
  }
  let summary: string;
  if (changedKeys.length === 1) {
    summary = `Update protocol parameter: ${changedKeys[0]}`;
  } else if (changedKeys.length <= 3) {
    summary = `Update protocol parameters: ${changedKeys.join(', ')}`;
  } else {
    summary = `Update ${changedKeys.length} protocol parameters (incl. ${changedKeys
      .slice(0, 2)
      .join(', ')}…)`;
  }
  return { summary, details };
}

function summarizeNoConfidence(_d: RawDescription): GovernanceSummary {
  return {
    summary: 'Vote of no confidence in the current constitutional committee',
    details: [],
  };
}

function summarizeUpdateCommittee(d: RawDescription): GovernanceSummary {
  // Best-effort: contents = [prevActionId|null, removed[], added{coldKey: epoch}, threshold]
  const contents = Array.isArray(d.contents) ? (d.contents as unknown[]) : [];
  const removed = Array.isArray(contents[1]) ? (contents[1] as unknown[]) : [];
  const addedRaw = (contents[2] ?? {}) as Record<string, unknown>;
  const threshold = contents[3];
  const details: GovernanceDetail[] = [];

  if (removed.length > 0) {
    details.push({
      label: 'Members removed',
      value: removed
        .map((m) => (typeof m === 'string' ? shortAddress(m) : JSON.stringify(m)))
        .join(', '),
    });
  }
  const addedKeys = Object.keys(addedRaw);
  if (addedKeys.length > 0) {
    details.push({
      label: 'Members added',
      value: addedKeys
        .map((k) => `${shortAddress(k)} (until epoch ${asNumber(addedRaw[k]) ?? '?'})`)
        .join(', '),
    });
  }
  if (threshold != null) {
    details.push({ label: 'New threshold', value: JSON.stringify(threshold) });
  }
  const parts: string[] = [];
  if (addedKeys.length > 0) parts.push(`add ${addedKeys.length}`);
  if (removed.length > 0) parts.push(`remove ${removed.length}`);
  const summary =
    parts.length > 0
      ? `Update constitutional committee (${parts.join(', ')})`
      : 'Update constitutional committee';
  return { summary, details };
}

function summarizeNewConstitution(d: RawDescription): GovernanceSummary {
  const contents = Array.isArray(d.contents) ? (d.contents as unknown[]) : [];
  const body = (contents[1] ?? {}) as Record<string, unknown>;
  const anchor = (body['anchor'] ?? {}) as Record<string, unknown>;
  const url = asString(anchor['url']);
  const dataHash = asString(anchor['dataHash']);
  const script = asString(body['script']);
  const details: GovernanceDetail[] = [];
  if (url) details.push({ label: 'Constitution URL', value: url });
  if (dataHash) details.push({ label: 'Constitution hash', value: dataHash });
  if (script) details.push({ label: 'Guard script', value: shortAddress(script) });
  return {
    summary: url ? `Adopt new constitution at ${url}` : 'Adopt new constitution',
    details,
  };
}

function summarizeInfoAction(_d: RawDescription): GovernanceSummary {
  // InfoAction has no on-chain payload — anchor metadata fills the gap.
  return { summary: '', details: [] };
}

// ---- Public entry point ----

/**
 * Build a human-readable summary from Blockfrost's `governance_description`.
 * Always returns a value; errors are caught and degraded to an empty summary.
 */
export function summarizeGovernanceDescription(
  actionType: GovernanceActionType,
  description: Record<string, unknown> | null | undefined,
): GovernanceSummary {
  const d: RawDescription = description ?? {};
  try {
    switch (actionType) {
      case 'TreasuryWithdrawals':
        return summarizeTreasuryWithdrawals(d);
      case 'HardForkInitiation':
        return summarizeHardForkInitiation(d);
      case 'ParameterChange':
        return summarizeParameterChange(d);
      case 'NoConfidence':
        return summarizeNoConfidence(d);
      case 'UpdateCommittee':
        return summarizeUpdateCommittee(d);
      case 'NewConstitution':
        return summarizeNewConstitution(d);
      case 'InfoAction':
        return summarizeInfoAction(d);
      default:
        return { summary: '', details: [] };
    }
  } catch (err) {
    // Defensive: never let a malformed payload crash the sync.
    console.warn('summarizeGovernanceDescription failed:', err);
    return { summary: '', details: [] };
  }
}
