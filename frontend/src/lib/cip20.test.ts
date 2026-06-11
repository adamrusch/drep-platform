/**
 * Unit tests for the CIP-20 helper (label 674).
 *
 * Coverage:
 *   - Byte-length counter handles ASCII and multi-byte (UTF-8) code points.
 *   - Chunker respects the 64-byte ceiling, splits long inputs in order,
 *     and never bisects a multi-byte code point.
 *   - Envelope builder concatenates per-message chunks in input order.
 *   - Default attribution envelope is well-formed and under-budget.
 *   - Empty-input guard throws.
 *   - {label, value} wrapper hits CIP-20 label 674.
 *   - Round-trip: re-joining the chunks reproduces the original message
 *     for both short and long inputs (chunker is lossless).
 */
import { describe, it, expect } from 'vitest';
import {
  CIP20_HELPER_VERSION,
  CIP20_LABEL,
  CIP20_MAX_CHUNK_BYTES,
  DEFAULT_ATTRIBUTION_MESSAGE,
  DEFAULT_ATTRIBUTION_TAG,
  buildCip20Envelope,
  buildDefaultDrepToolsAttribution,
  chunkUtf8,
  toMetadataEntry,
  utf8ByteLength,
} from './cip20';

describe('cip20 — constants', () => {
  it('exports CIP-20 label 674', () => {
    expect(CIP20_LABEL).toBe(674);
  });

  it('exports the 64-byte chunk ceiling', () => {
    expect(CIP20_MAX_CHUNK_BYTES).toBe(64);
  });

  it('pins the helper version', () => {
    expect(CIP20_HELPER_VERSION).toBe('v1');
  });
});

describe('utf8ByteLength', () => {
  it('counts ASCII as 1 byte per char', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('hello')).toBe(5);
    expect(utf8ByteLength('Voted via drep.tools')).toBe(20);
  });

  it('counts 2-byte sequences (Latin-1 supplement, accented chars)', () => {
    expect(utf8ByteLength('é')).toBe(2); // U+00E9 → 0xC3 0xA9
    expect(utf8ByteLength('ñ')).toBe(2);
  });

  it('counts 3-byte sequences (BMP, CJK)', () => {
    expect(utf8ByteLength('日')).toBe(3);
    expect(utf8ByteLength('日本語')).toBe(9);
  });

  it('counts 4-byte sequences (emoji, supplementary plane)', () => {
    // U+1F4A9 is a 4-byte UTF-8 sequence (surrogate pair in UTF-16).
    expect(utf8ByteLength('💩')).toBe(4);
  });
});

describe('chunkUtf8', () => {
  it('returns empty array for empty input', () => {
    expect(chunkUtf8('')).toEqual([]);
  });

  it('returns input unchanged when under the budget', () => {
    expect(chunkUtf8('hello')).toEqual(['hello']);
    expect(chunkUtf8(DEFAULT_ATTRIBUTION_MESSAGE)).toEqual([
      DEFAULT_ATTRIBUTION_MESSAGE,
    ]);
  });

  it('splits exactly at the 64-byte budget for ASCII', () => {
    // 130 ASCII chars → 3 chunks of 64/64/2 bytes.
    const input = 'a'.repeat(130);
    const chunks = chunkUtf8(input);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(64);
    expect(chunks[1]?.length).toBe(64);
    expect(chunks[2]?.length).toBe(2);
    // Round-trip preserves the original text.
    expect(chunks.join('')).toBe(input);
  });

  it('splits without bisecting a multi-byte code point', () => {
    // 30 CJK characters = 90 bytes; the first chunk should be the largest
    // run of whole CJK chars that stays ≤ 64 bytes. 64/3 = 21.33 → 21
    // chars = 63 bytes per chunk.
    const input = '日'.repeat(30);
    const chunks = chunkUtf8(input);
    // Each chunk must satisfy the byte budget.
    for (const c of chunks) {
      expect(utf8ByteLength(c)).toBeLessThanOrEqual(CIP20_MAX_CHUNK_BYTES);
    }
    // No chunk contains a U+FFFD replacement char (which would indicate
    // a bisected sequence).
    for (const c of chunks) {
      expect(c).not.toContain('�');
    }
    // Lossless round-trip.
    expect(chunks.join('')).toBe(input);
  });

  it('does not bisect a 4-byte emoji', () => {
    // 20 piles-of-poo = 80 bytes; budget is 64. The chunker should put
    // 16 emoji (64 bytes) in chunk 1 and the rest in chunk 2.
    const input = '💩'.repeat(20);
    const chunks = chunkUtf8(input);
    for (const c of chunks) {
      expect(utf8ByteLength(c)).toBeLessThanOrEqual(CIP20_MAX_CHUNK_BYTES);
    }
    expect(chunks.join('')).toBe(input);
    // The first chunk should hold exactly 16 emoji (16 * 4 = 64 bytes).
    expect(chunks[0]).toBe('💩'.repeat(16));
  });

  it('honours a custom maxBytes for testing', () => {
    const chunks = chunkUtf8('hello world', 4);
    expect(chunks).toEqual(['hell', 'o wo', 'rld']);
  });

  it('rejects non-positive maxBytes', () => {
    expect(() => chunkUtf8('x', 0)).toThrow(/positive/);
    expect(() => chunkUtf8('x', -1)).toThrow(/positive/);
  });
});

describe('buildCip20Envelope', () => {
  it('wraps a single short message in a 1-chunk msg array', () => {
    const env = buildCip20Envelope(['Voted via drep.tools']);
    expect(env).toEqual({ msg: ['Voted via drep.tools'] });
  });

  it('preserves input ordering across multiple messages', () => {
    const env = buildCip20Envelope(['first', 'second']);
    expect(env).toEqual({ msg: ['first', 'second'] });
  });

  it('chunks a >64-byte message and keeps trailing messages in order', () => {
    const long = 'x'.repeat(100);
    const env = buildCip20Envelope([long, 'tail']);
    // 100 bytes → 64 + 36 = 2 chunks; "tail" → 1 chunk → 3 entries total.
    expect(env.msg.length).toBe(3);
    expect(env.msg[2]).toBe('tail');
    expect(env.msg[0]?.length).toBe(64);
    expect(env.msg[0] + env.msg[1]).toBe(long);
  });

  it('throws when all messages are empty', () => {
    expect(() => buildCip20Envelope([])).toThrow(/non-empty/);
    expect(() => buildCip20Envelope(['', '', ''])).toThrow(/non-empty/);
  });
});

describe('buildDefaultDrepToolsAttribution', () => {
  it('builds the default 2-entry attribution envelope', () => {
    const env = buildDefaultDrepToolsAttribution();
    expect(env).toEqual({
      msg: [DEFAULT_ATTRIBUTION_MESSAGE, DEFAULT_ATTRIBUTION_TAG],
    });
  });

  it('every chunk is at most 64 bytes', () => {
    const env = buildDefaultDrepToolsAttribution();
    for (const c of env.msg) {
      expect(utf8ByteLength(c)).toBeLessThanOrEqual(CIP20_MAX_CHUNK_BYTES);
    }
  });

  it('contains the machine-readable drep-tools tag for analysts to grep', () => {
    const env = buildDefaultDrepToolsAttribution();
    expect(env.msg).toContain('drep-tools');
  });
});

describe('toMetadataEntry', () => {
  it('wraps an envelope as a {label: 674, value: envelope} pair', () => {
    const env = buildDefaultDrepToolsAttribution();
    const entry = toMetadataEntry(env);
    expect(entry.label).toBe(674);
    expect(entry.value).toBe(env);
  });
});

describe('cip20 — round-trip', () => {
  it('chunks join back losslessly for a variety of inputs', () => {
    const inputs = [
      'short',
      'a'.repeat(64),
      'a'.repeat(65),
      'a'.repeat(200),
      '日本語'.repeat(30),
      '💩'.repeat(20),
      'mixed日本💩content with 🤖 emoji and accents éñ',
    ];
    for (const input of inputs) {
      const chunks = chunkUtf8(input);
      expect(chunks.join('')).toBe(input);
      // The reconstructed envelope should also round-trip when packed.
      const env = buildCip20Envelope([input]);
      expect(env.msg.join('')).toBe(input);
    }
  });
});
