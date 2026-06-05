import { describe, it, expect, vi, beforeEach } from 'vitest';
import blake2b from 'blake2b';
import { extractVoteRationale, fetchVoteRationale } from './voteRationale';

vi.mock('./ipfsGateway', () => ({
  extractIpfsCid: vi.fn(),
  fetchIpfsAnchor: vi.fn(),
}));

import { extractIpfsCid, fetchIpfsAnchor } from './ipfsGateway';
const mockExtractCid = vi.mocked(extractIpfsCid);
const mockFetchIpfs = vi.mocked(fetchIpfsAnchor);

function blakeHex(s: string): string {
  const out = Buffer.alloc(32);
  blake2b(32).update(Buffer.from(s, 'utf-8')).digest(out);
  return out.toString('hex');
}

const HASH = 'a'.repeat(64);

describe('extractVoteRationale', () => {
  it('prefers CIP-100 body.comment', () => {
    const r = extractVoteRationale({ body: { comment: 'I support this.', rationale: 'other' } });
    expect(r.text).toBe('I support this.');
  });

  it('falls back to CIP-108 rationale/abstract/motivation when no comment', () => {
    expect(extractVoteRationale({ body: { rationale: 'because reasons' } }).text).toBe('because reasons');
    expect(extractVoteRationale({ body: { abstract: 'abs' } }).text).toBe('abs');
    expect(extractVoteRationale({ body: { motivation: 'mot' } }).text).toBe('mot');
  });

  it('extracts title from body.title', () => {
    const r = extractVoteRationale({ body: { title: 'My vote', comment: 'c' } });
    expect(r.title).toBe('My vote');
    expect(r.text).toBe('c');
  });

  it('handles a bare top-level object (no body wrapper)', () => {
    expect(extractVoteRationale({ comment: 'flat comment' }).text).toBe('flat comment');
  });

  it('returns {} for empty / non-object / textless input', () => {
    expect(extractVoteRationale(null)).toEqual({});
    expect(extractVoteRationale('nope')).toEqual({});
    expect(extractVoteRationale({ body: { references: [] } })).toEqual({});
  });

  it('truncates very long text and flags it', () => {
    const long = 'x'.repeat(20_000);
    const r = extractVoteRationale({ body: { comment: long } });
    expect(r.truncated).toBe(true);
    expect((r.text ?? '').length).toBe(12_000);
  });
});

describe('fetchVoteRationale', () => {
  beforeEach(() => {
    mockExtractCid.mockReset();
    mockFetchIpfs.mockReset();
    vi.restoreAllMocks();
  });

  it('returns empty for a missing url', async () => {
    expect((await fetchVoteRationale(undefined, undefined)).status).toBe('empty');
    expect((await fetchVoteRationale('', HASH)).status).toBe('empty');
  });

  it('caches an IPFS anchor with a matching hash', async () => {
    mockExtractCid.mockReturnValue('QmCID');
    mockFetchIpfs.mockResolvedValue({
      body: JSON.stringify({ body: { title: 'T', comment: 'hello' } }),
      gatewayUsed: 'https://ipfs.io/ipfs/QmCID',
      computedHash: HASH,
      hashMatch: true,
    });
    const r = await fetchVoteRationale('ipfs://QmCID', HASH);
    expect(r.status).toBe('cached');
    expect(r.title).toBe('T');
    expect(r.text).toBe('hello');
    expect(r.hashMatch).toBe(true);
  });

  it('marks hash_mismatch when the IPFS body fails verification', async () => {
    mockExtractCid.mockReturnValue('QmCID');
    mockFetchIpfs.mockResolvedValue({
      body: JSON.stringify({ body: { comment: 'maybe wrong' } }),
      gatewayUsed: 'https://ipfs.io/ipfs/QmCID',
      computedHash: 'b'.repeat(64),
      hashMatch: false,
    });
    const r = await fetchVoteRationale('ipfs://QmCID', HASH);
    expect(r.status).toBe('hash_mismatch');
    expect(r.text).toBe('maybe wrong');
    expect(r.hashMatch).toBe(false);
  });

  it('returns unsupported for an IPFS anchor with no verifiable hash', async () => {
    mockExtractCid.mockReturnValue('QmCID');
    const r = await fetchVoteRationale('ipfs://QmCID', 'not-a-hash');
    expect(r.status).toBe('unsupported');
    expect(mockFetchIpfs).not.toHaveBeenCalled();
  });

  it('returns unreachable when no gateway serves the IPFS body', async () => {
    mockExtractCid.mockReturnValue('QmCID');
    mockFetchIpfs.mockResolvedValue(null);
    expect((await fetchVoteRationale('ipfs://QmCID', HASH)).status).toBe('unreachable');
  });

  it('caches an https anchor and verifies its hash', async () => {
    mockExtractCid.mockReturnValue(null);
    const doc = JSON.stringify({ body: { comment: 'https rationale' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(doc, { status: 200 }));
    const r = await fetchVoteRationale('https://example.com/r.json', blakeHex(doc));
    expect(r.status).toBe('cached');
    expect(r.text).toBe('https rationale');
    expect(r.hashMatch).toBe(true);
  });

  it('https anchor with no hash is cached but unverified (hashMatch undefined)', async () => {
    mockExtractCid.mockReturnValue(null);
    const doc = JSON.stringify({ body: { comment: 'unverified' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(doc, { status: 200 }));
    const r = await fetchVoteRationale('https://example.com/r.json', undefined);
    expect(r.status).toBe('cached');
    expect(r.hashMatch).toBeUndefined();
  });

  it('returns unsupported for non-ipfs/non-https schemes', async () => {
    mockExtractCid.mockReturnValue(null);
    expect((await fetchVoteRationale('ar://abc', HASH)).status).toBe('unsupported');
  });

  it('returns empty when the fetched body is not usable JSON', async () => {
    mockExtractCid.mockReturnValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    expect((await fetchVoteRationale('https://example.com/r.json', undefined)).status).toBe('empty');
  });
});
