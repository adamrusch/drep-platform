import blake2b from 'blake2b';
import type { CommitteeRationaleDraftItem, CommitteePosition } from './types';

/**
 * Deterministic JSON serialization: object keys sorted recursively, no extra
 * whitespace. The anchor hash MUST be computed over canonical bytes so that
 * anyone re-deriving the hash from the same content gets the same digest
 * (on-chain indexers reject anchor-hash mismatches).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** blake2b-256 (32-byte) hex digest of a UTF-8 string. */
export function blake2b256Hex(input: string): string {
  const out = Buffer.alloc(32);
  blake2b(32).update(Buffer.from(input, 'utf8')).digest(out);
  return out.toString('hex');
}

/** Minimal CIP-100 JSON-LD context for governance rationale metadata. */
const CIP100_CONTEXT = {
  '@language': 'en-us',
  CIP100: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#',
  CIP108: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0108/README.md#',
  hashAlgorithm: 'CIP100:hashAlgorithm',
  body: {
    '@id': 'CIP108:body',
    '@context': {
      references: 'CIP108:references',
      summary: 'CIP108:summary',
      rationaleStatement: 'CIP108:rationaleStatement',
      precedentDiscussion: 'CIP108:precedentDiscussion',
      counterargumentDiscussion: 'CIP108:counterargumentDiscussion',
      conclusion: 'CIP108:conclusion',
      internalVote: 'CIP108:internalVote',
    },
  },
  authors: 'CIP100:authors',
};

/**
 * Assemble the CIP-100/108 anchor document from a committee rationale draft and
 * compute its blake2b-256 hash over the canonical bytes. The returned
 * `canonicalJson` is exactly what must be pinned to IPFS and what the on-chain
 * anchor hash refers to.
 */
export function buildRationaleAnchor(
  draft: CommitteeRationaleDraftItem,
  meta: { drepId: string; actionId: string; position: CommitteePosition },
): { canonicalJson: string; anchorHash: string } {
  const body: Record<string, unknown> = {
    summary: draft.summary ?? `DRep committee position (${meta.position}) on ${meta.actionId}`,
    rationaleStatement: draft.rationaleStatement,
  };
  if (draft.precedentDiscussion) body['precedentDiscussion'] = draft.precedentDiscussion;
  if (draft.counterargumentDiscussion) body['counterargumentDiscussion'] = draft.counterargumentDiscussion;
  if (draft.conclusion) body['conclusion'] = draft.conclusion;
  if (draft.internalVote) body['internalVote'] = draft.internalVote;
  if (draft.references && draft.references.length > 0) body['references'] = draft.references;

  const doc: Record<string, unknown> = {
    '@context': CIP100_CONTEXT,
    hashAlgorithm: 'blake2b-256',
    body,
  };
  if (draft.authors && draft.authors.length > 0) doc['authors'] = draft.authors;

  const canonicalJson = canonicalize(doc);
  return { canonicalJson, anchorHash: blake2b256Hex(canonicalJson) };
}
