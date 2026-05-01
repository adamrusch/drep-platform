import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { GovernanceAction, GovernanceActionType, GovernanceActionStatus } from './types';

// ---- Secrets Manager ----

const secretsClient = new SecretsManagerClient({ region: process.env['SES_REGION'] ?? 'us-east-1' });
let _apiKeyCache: string | null = null;

async function getBlockfrostApiKey(): Promise<string> {
  if (_apiKeyCache) return _apiKeyCache;
  // Support both direct key (legacy) and secret name path
  const nameOrKey = process.env['BLOCKFROST_SECRET_NAME'] ?? process.env['BLOCKFROST_API_KEY'];
  if (!nameOrKey) throw new Error('BLOCKFROST_SECRET_NAME environment variable is not set');
  if (!nameOrKey.includes('/')) {
    _apiKeyCache = nameOrKey;
    return nameOrKey;
  }
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: nameOrKey }));
  if (!result.SecretString) throw new Error('Blockfrost secret has no string value');
  _apiKeyCache = result.SecretString;
  return _apiKeyCache;
}

// ---- Client setup ----

let _client: BlockFrostAPI | null = null;

async function getClient(): Promise<BlockFrostAPI> {
  if (!_client) {
    const apiKey = await getBlockfrostApiKey();
    const network = process.env['CARDANO_NETWORK'] ?? 'mainnet';
    _client = new BlockFrostAPI({
      projectId: apiKey,
      network: network as 'mainnet' | 'preview' | 'preprod',
      requestTimeout: 15_000,
      retrySettings: {
        limit: 3,
        methods: ['GET'],
        statusCodes: [429, 500, 502, 503, 504],
        errorCodes: ['ECONNRESET', 'ETIMEDOUT'],
        calculateDelay: ({ attemptCount }) => attemptCount * 1000,
      },
    });
  }
  return _client;
}

export async function getBlockfrostClient(): Promise<BlockFrostAPI> {
  return getClient();
}

// ---- Typed local interfaces (not importing from @blockfrost/openapi to avoid version skew) ----

export interface BlockfrostProposal {
  tx_hash: string;
  cert_index: number;
  governance_type: string;
  deposit: string;
  return_address: string;
  governance_description: Record<string, unknown>;
  ratified_epoch?: number | null;
  enacted_epoch?: number | null;
  dropped_epoch?: number | null;
  expired_epoch?: number | null;
  expiration?: number | null;
}

export interface BlockfrostDRep {
  drep_id: string;
  amount: string;
  active: boolean;
  active_epoch: number;
  has_script: boolean;
}

export interface BlockfrostDRepDelegator {
  address: string;
  amount: string;
}

export interface BlockfrostAccount {
  stake_address: string;
  active: boolean;
  active_epoch?: number | null;
  controlled_amount: string;
  rewards_sum: string;
  withdrawals_sum: string;
  reserves_sum: string;
  treasury_sum: string;
  withdrawable_amount: string;
  drep_id?: string | null;
  pool_id?: string | null;
}

export interface BlockfrostEpoch {
  epoch: number;
  start_time: number;
  end_time: number;
  first_block_time: number;
  last_block_time: number;
  block_count: number;
  tx_count: number;
  output: string;
  fees: string;
  active_stake?: string | null;
}

// ---- Map governance_type to our enum ----

function mapActionType(raw: string): GovernanceActionType {
  const mapping: Record<string, GovernanceActionType> = {
    ParameterChange: 'ParameterChange',
    HardForkInitiation: 'HardForkInitiation',
    TreasuryWithdrawals: 'TreasuryWithdrawals',
    NoConfidence: 'NoConfidence',
    UpdateCommittee: 'UpdateCommittee',
    NewConstitution: 'NewConstitution',
    InfoAction: 'InfoAction',
    parameter_change: 'ParameterChange',
    hard_fork_initiation: 'HardForkInitiation',
    treasury_withdrawals: 'TreasuryWithdrawals',
    no_confidence: 'NoConfidence',
    update_committee: 'UpdateCommittee',
    new_constitution: 'NewConstitution',
    info_action: 'InfoAction',
  };
  return mapping[raw] ?? 'InfoAction';
}

function mapStatus(raw: BlockfrostProposal, currentEpoch: number): GovernanceActionStatus {
  if (raw.enacted_epoch != null) return 'enacted';
  if (raw.dropped_epoch != null) return 'dropped';
  if (raw.expired_epoch != null) return 'expired';
  if (raw.expiration != null && raw.expiration < currentEpoch) return 'expired';
  return 'active';
}

// ---- Wrapper functions ----

export async function listGovernanceActions(
  page = 1,
  count = 100,
): Promise<BlockfrostProposal[]> {
  const client = await getClient();
  const results = await client.governance.proposals({ page, count, order: 'desc' });
  return results as unknown as BlockfrostProposal[];
}

export async function getGovernanceAction(
  txHash: string,
  certIndex: number,
): Promise<BlockfrostProposal> {
  const client = await getClient();
  const result = await client.governance.proposal(txHash, certIndex);
  return result as unknown as BlockfrostProposal;
}

export async function getDRep(drepId: string): Promise<BlockfrostDRep> {
  const client = await getClient();
  const result = await client.governance.drepsById(drepId);
  return result as unknown as BlockfrostDRep;
}

export async function getDRepDelegations(
  drepId: string,
  page = 1,
  count = 100,
): Promise<BlockfrostDRepDelegator[]> {
  const client = await getClient();
  const result = await client.governance.drepsByIdDelegators(drepId, { page, count });
  return result as unknown as BlockfrostDRepDelegator[];
}

export async function getAccountInfo(stakeAddress: string): Promise<BlockfrostAccount> {
  const client = await getClient();
  const result = await client.accounts(stakeAddress);
  return result as unknown as BlockfrostAccount;
}

export async function getLatestEpoch(): Promise<BlockfrostEpoch> {
  const client = await getClient();
  const result = await client.epochsLatest();
  return result as unknown as BlockfrostEpoch;
}

// ---- Higher-level mapper ----

export function mapBlockfrostProposalToGovernanceAction(
  raw: BlockfrostProposal,
  currentEpoch: number,
  existingTitle?: string,
  existingDescription?: string,
): Omit<GovernanceAction, 'ingestedAt' | 'lastSyncedAt'> {
  const actionId = `${raw.tx_hash}#${raw.cert_index}`;
  const metadata = raw.governance_description ?? {};
  return {
    actionId,
    actionType: mapActionType(raw.governance_type),
    title: existingTitle ?? (metadata['title'] as string) ?? actionId,
    description:
      existingDescription ??
      (metadata['abstract'] as string) ??
      (metadata['motivation'] as string) ??
      '',
    submittedAt: new Date(0).toISOString(),
    epochDeadline: raw.expiration ?? 0,
    status: mapStatus(raw, currentEpoch),
    sourceMetadata: undefined,
    links: undefined,
  };
}
