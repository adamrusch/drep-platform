import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const IPFS_BASE = 'https://ipfs.blockfrost.io/api/v0';

const secretsClient = new SecretsManagerClient({
  region: process.env['SES_REGION'] ?? 'us-east-1',
});

/**
 * Pin a JSON document to IPFS via Blockfrost's IPFS API using the DRep's own
 * project id. Two calls: /ipfs/add (upload) then /ipfs/pin/add/{cid} (pin so it
 * persists). Returns the CID + ipfs:// URI to embed in the vote anchor.
 */
export async function pinJsonToIpfs(
  canonicalJson: string,
  ipfsProjectId: string,
): Promise<{ cid: string; uri: string }> {
  const form = new FormData();
  form.append('file', new Blob([canonicalJson], { type: 'application/json' }), 'rationale.json');

  const addRes = await fetch(`${IPFS_BASE}/ipfs/add`, {
    method: 'POST',
    headers: { project_id: ipfsProjectId },
    body: form,
  });
  if (!addRes.ok) {
    throw new Error(`IPFS add failed (${addRes.status}): ${await safeText(addRes)}`);
  }
  const added = (await addRes.json()) as { ipfs_hash: string };
  const cid = added.ipfs_hash;

  const pinRes = await fetch(`${IPFS_BASE}/ipfs/pin/add/${cid}`, {
    method: 'POST',
    headers: { project_id: ipfsProjectId },
  });
  // 400 commonly means "already pinned" — not a failure for our purposes.
  if (!pinRes.ok && pinRes.status !== 400) {
    throw new Error(`IPFS pin failed (${pinRes.status}): ${await safeText(pinRes)}`);
  }

  return { cid, uri: `ipfs://${cid}` };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

// ---- Per-DRep IPFS key storage (opt-in, encrypted in Secrets Manager) ----

function ipfsSecretName(stage: string, drepId: string): string {
  return `drep-platform/${stage}/drep-ipfs/${drepId}`;
}

export async function getStoredIpfsKey(
  stage: string,
  drepId: string,
): Promise<string | undefined> {
  try {
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: ipfsSecretName(stage, drepId) }),
    );
    return res.SecretString ?? undefined;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ResourceNotFoundException') {
      return undefined;
    }
    throw err;
  }
}

export async function hasStoredIpfsKey(stage: string, drepId: string): Promise<boolean> {
  return (await getStoredIpfsKey(stage, drepId)) !== undefined;
}

export async function storeIpfsKey(
  stage: string,
  drepId: string,
  key: string,
): Promise<void> {
  const name = ipfsSecretName(stage, drepId);
  try {
    await secretsClient.send(
      new CreateSecretCommand({ Name: name, SecretString: key }),
    );
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ResourceExistsException') {
      await secretsClient.send(new PutSecretValueCommand({ SecretId: name, SecretString: key }));
      return;
    }
    throw err;
  }
}
