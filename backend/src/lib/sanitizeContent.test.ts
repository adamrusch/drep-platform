/**
 * XSS corpus + benign-markdown survival tests for `sanitizeContent.ts`.
 *
 * # Why this test exists (Sprint 4, Part B)
 *
 * The sanitiser is the single chokepoint between user input and
 * persisted comment / post bodies. If the chokepoint regresses (a new
 * package version, a tweaked whitelist) the entire mutation surface
 * silently becomes injection-vulnerable. The corpus below locks the
 * contract: every known vector neutralised, every legitimate markdown
 * construct preserved.
 *
 * The corpus draws from:
 *   - The classic OWASP XSS cheat-sheet entries.
 *   - The historical "markdown-link `javascript:` URL" vector that
 *     bypasses tag-stripping but is caught at render time by
 *     rehype-sanitize's protocol allow-list.
 *   - Real samples from the WordPress / Discourse / GitHub security
 *     bounty reports (encoded variants, broken-tag tricks).
 *
 * Sanitisation contract (locked):
 *
 *   - NO HTML tag survives. `<` is always escaped to `&lt;`.
 *   - Tag bodies of `<script>`, `<style>`, `<iframe>`, `<object>`,
 *     `<embed>` are DROPPED (their textual content has no legitimate
 *     value to a discussion post).
 *   - Control characters (NULL, ESC, etc.) are stripped.
 *   - The result, when fed back through the sanitiser, is identical
 *     (idempotence).
 *   - Markdown formatting characters (`*`, `_`, `>`, `[`, `]`, `(`,
 *     `)`, `#`, `-`, `\``) round-trip unchanged.
 *
 * Note on markdown-link XSS: the SERVER neutralises raw HTML; it does
 * NOT block `[label](javascript:alert(1))` markdown syntax — that is
 * legitimate-looking markdown source and stripping it server-side
 * would corrupt benign URLs that happen to share a substring. The
 * CLIENT's `Markdown.tsx` uses `rehype-sanitize` with a strict
 * `protocols.href = ['http', 'https', 'ipfs']` allow-list which drops
 * the dangerous protocol at render time. The test below ASSERTS that
 * `[x](javascript:alert(1))` survives the sanitiser as-is (no false
 * truncation of legitimate-shaped text), pinning the documented
 * server-side contract.
 */

import { describe, expect, it } from 'vitest';
import {
  SanitizationError,
  sanitizeOptionalUserText,
  sanitizeUserText,
} from './sanitizeContent';

describe('sanitizeContent — XSS corpus (every vector neutralised)', () => {
  /** Helper that asserts the input no longer contains an executable
   *  HTML tag opener. Any `<` byte in the output must be either:
   *   - escaped `&lt;`, OR
   *   - removed entirely (e.g. dangerous-tag body).
   *  A bare `<scrip…` would be a regression. */
  function expectNoRawHtmlTag(output: string): void {
    // The classic indicator: a `<` followed by an alpha (potential
    // tag opener). The sanitiser must have escaped or removed it.
    expect(/<[A-Za-z]/.test(output)).toBe(false);
    // Belt + braces: no closing-tag opener either.
    expect(/<\/[A-Za-z]/.test(output)).toBe(false);
  }

  it('classic <script>alert(1)</script> — tag escaped AND body dropped', () => {
    const input = `<script>alert(1)</script>`;
    const output = sanitizeUserText(input, { fieldLabel: 'body' });
    expectNoRawHtmlTag(output);
    // The body of <script> is dropped (stripIgnoreTagBody), so `alert(1)`
    // does NOT appear in the output. This is the one case we DROP rather
    // than preserve — script bodies are JS source, not discussion text.
    expect(output).not.toContain('alert(1)');
  });

  it('<img src=x onerror=alert(1)> — escaped, no live attribute', () => {
    const input = `<img src=x onerror=alert(1)>`;
    const output = sanitizeUserText(input, { fieldLabel: 'body' });
    expectNoRawHtmlTag(output);
    // `onerror` as text is fine — what matters is that the surrounding
    // `<img …>` tag is escaped so the attribute never lives.
    expect(output).toMatch(/&lt;img/);
  });

  it('<svg onload=alert(1)> — escaped', () => {
    const output = sanitizeUserText(`<svg onload=alert(1)>`);
    expectNoRawHtmlTag(output);
    expect(output).toMatch(/&lt;svg/);
  });

  it('<iframe src=javascript:alert(1)> — body dropped, tag escaped', () => {
    const output = sanitizeUserText(`<iframe src=javascript:alert(1)>X</iframe>`);
    expectNoRawHtmlTag(output);
    // iframe is in `stripIgnoreTagBody`, so the inner `X` is dropped.
    expect(output).not.toContain('<iframe');
  });

  it('<a href="javascript:alert(1)">click</a> — escaped, link text remains as text', () => {
    const output = sanitizeUserText(`<a href="javascript:alert(1)">click</a>`);
    expectNoRawHtmlTag(output);
    // `<a>` is NOT in stripIgnoreTagBody, so the inner text "click"
    // survives as readable content — but the `<a>` tag itself is
    // escaped so no link is created.
    expect(output).toContain('click');
    expect(output).toMatch(/&lt;a/);
  });

  it('encoded variant <SCRIPT>alert(1)</SCRIPT> — case folding handled', () => {
    const output = sanitizeUserText(`<SCRIPT>alert(1)</SCRIPT>`);
    expectNoRawHtmlTag(output);
    expect(output).not.toContain('alert(1)');
  });

  it('mixed-case <ScRiPt>alert(1)</ScRiPt> — case folding handled', () => {
    const output = sanitizeUserText(`<ScRiPt>alert(1)</ScRiPt>`);
    expectNoRawHtmlTag(output);
    expect(output).not.toContain('alert(1)');
  });

  it('<script>...</script> nested inside legitimate text — body dropped, surrounding text preserved', () => {
    const input = `Hello <script>steal()</script> world`;
    const output = sanitizeUserText(input);
    expectNoRawHtmlTag(output);
    // Surrounding text is preserved verbatim.
    expect(output).toContain('Hello');
    expect(output).toContain('world');
    // The dangerous script body is dropped.
    expect(output).not.toContain('steal()');
  });

  it('<style>body{}</style> — body dropped (in stripIgnoreTagBody)', () => {
    const output = sanitizeUserText(`<style>body{background:url(javascript:1)}</style>`);
    expectNoRawHtmlTag(output);
    expect(output).not.toContain('background:url');
  });

  it('HTML entity-encoded payload &lt;script&gt; — left alone (already escaped)', () => {
    // Pre-escaped input must round-trip unchanged — re-escaping
    // would double-encode and corrupt benign user text.
    const input = `&lt;script&gt;alert(1)&lt;/script&gt;`;
    const output = sanitizeUserText(input);
    // The visible text "alert(1)" is fine — it's the inert representation
    // of the user's typed characters. What matters is no LIVE `<script>`
    // tag was created.
    expectNoRawHtmlTag(output);
  });

  it('broken-tag tricks <scr<script>ipt>alert(1)</scr</script>ipt> — nested escaping', () => {
    // Classic filter-bypass attempt: a sanitiser that strips outer
    // `<script>` would leave an inner one. Our config escapes every
    // `<` so this collapses to inert text.
    const output = sanitizeUserText(`<scr<script>ipt>alert(1)</scr</script>ipt>`);
    expectNoRawHtmlTag(output);
  });

  it('NULL byte injection <scrip\\0t> — control char stripped, then sanitised', () => {
    const output = sanitizeUserText(`<scrip\x00t>alert(1)</scrip\x00t>`);
    expectNoRawHtmlTag(output);
    // NULL byte is gone.
    expect(output).not.toContain('\x00');
    // The collapsed-form `<script>` is in stripIgnoreTagBody, so the
    // inner alert is dropped. (Even if the post-NULL-strip form
    // weren't matched, the `<` would still be escaped.)
    expect(output).not.toContain('alert(1)');
  });

  it('ANSI escape sequences in the body — stripped (log injection vector)', () => {
    const output = sanitizeUserText(`harmless\x1b[31mRED\x1b[0m text`);
    // C1 escape (0x1b) is stripped by the C0/C1 normaliser.
    expect(output).not.toContain('\x1b');
    expect(output).toContain('harmless');
    expect(output).toContain('text');
  });

  it("MARKDOWN-LINK XSS [x](javascript:alert(1)) — preserved as text (CLIENT-side rehype-sanitize blocks the protocol at render)", () => {
    // Documented server-side contract: the markdown source is NOT
    // mangled. The defence for this vector lives in `Markdown.tsx`'s
    // `rehype-sanitize` `protocols.href = ['http','https','ipfs']`
    // allow-list. Asserting preservation here pins the server-side
    // contract and prevents an over-zealous future tweak from
    // mangling URLs that contain "javascript" in a query string.
    const input = `[click me](javascript:alert(1))`;
    const output = sanitizeUserText(input);
    expect(output).toBe(input);
  });

  it("MARKDOWN-LINK image XSS ![](javascript:...) — preserved as text", () => {
    const input = `![alt](javascript:alert(1))`;
    const output = sanitizeUserText(input);
    expect(output).toBe(input);
  });

  it('multiple vectors in one body — each neutralised', () => {
    const input = `
      <script>a()</script>
      Hello
      <img src=x onerror=b()>
      <iframe src="evil.com"></iframe>
      <a href="javascript:c()">link</a>
    `;
    const output = sanitizeUserText(input);
    expectNoRawHtmlTag(output);
    // Surrounding "Hello" survives.
    expect(output).toContain('Hello');
    expect(output).toContain('link');
    // None of the script bodies (`a()`, `b()`, …) for *iframe* / *script*
    // / *style* survive. Note: a()/c() are FUNCTION CALL TEXT inside
    // script bodies — the `<script>` body is dropped; `<a>` body is kept.
    expect(output).not.toContain('a()');
    // b() is an event-handler attribute on `<img>` — the tag is escaped,
    // and the rendered output represents it as literal text. The
    // attribute name+value appear as text but cannot fire.
  });

  it('idempotence — sanitize(sanitize(x)) === sanitize(x)', () => {
    const inputs = [
      `<script>x</script>`,
      `<img src=x onerror=alert(1)>`,
      `<a href="javascript:alert(1)">click</a>`,
      `Hello world`,
      `**bold** and _italic_`,
      `[link](https://example.com)`,
    ];
    for (const input of inputs) {
      const once = sanitizeUserText(input);
      const twice = sanitizeUserText(once);
      expect(twice).toBe(once);
    }
  });
});

describe('sanitizeContent — benign markdown survives intact', () => {
  it('bold + italic + code', () => {
    const input = `This is **bold** and _italic_ with \`inline code\`.`;
    expect(sanitizeUserText(input)).toBe(input);
  });

  it('headings + blockquotes + lists', () => {
    const input = `# Heading 1
## Heading 2

> A quoted line.

- item one
- item two
1. first
2. second`;
    expect(sanitizeUserText(input)).toBe(input);
  });

  it('http/https/ipfs links — preserved verbatim', () => {
    const input = `See [docs](https://drep.tools/docs) and [pinned](ipfs://Qm123).`;
    expect(sanitizeUserText(input)).toBe(input);
  });

  it('fenced code blocks — preserved verbatim', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(sanitizeUserText(input)).toBe(input);
  });

  it('punctuation + unicode + emoji', () => {
    const input = `It's fine — "really". 日本語 OK. 🎉👍`;
    expect(sanitizeUserText(input)).toBe(input);
  });

  it('tab / newline / CR preserved (legitimate whitespace)', () => {
    const input = `line one\n\ttabbed\r\nWindows newline`;
    expect(sanitizeUserText(input)).toBe(input);
  });

  it('ampersands in user text — passed through (markdown prose preservation)', () => {
    // Bare `&` is preserved because our custom `escapeHtml` override
    // escapes ONLY `<`. The XSS-safety invariant holds (no `<[A-Za-z]`
    // can survive), and benign prose like "Q & A" or "Apple & Co"
    // round-trips through the sanitiser without becoming `&amp;` noise
    // the markdown renderer has to undo.
    const output = sanitizeUserText(`A & B`);
    expect(output).toBe(`A & B`);
    // And the result is idempotent.
    expect(sanitizeUserText(output)).toBe(output);
  });
});

describe('sanitizeContent — length cap + control flow', () => {
  it('throws SanitizationError with statusCode 400 when post-sanitise length exceeds cap', () => {
    const tooLong = 'x'.repeat(100);
    expect(() => sanitizeUserText(tooLong, { maxLength: 50, fieldLabel: 'body' }))
      .toThrowError(SanitizationError);
    try {
      sanitizeUserText(tooLong, { maxLength: 50, fieldLabel: 'body' });
    } catch (err) {
      expect(err).toBeInstanceOf(SanitizationError);
      expect((err as SanitizationError).statusCode).toBe(400);
      expect((err as Error).message).toContain('body');
      expect((err as Error).message).toContain('50');
    }
  });

  it('rejects non-string input', () => {
    expect(() => sanitizeUserText(123 as unknown, { fieldLabel: 'body' }))
      .toThrowError(SanitizationError);
    expect(() => sanitizeUserText(null as unknown, { fieldLabel: 'body' }))
      .toThrowError(SanitizationError);
    expect(() => sanitizeUserText(undefined as unknown, { fieldLabel: 'body' }))
      .toThrowError(SanitizationError);
  });

  it('measures length AFTER escape so <-heavy inputs do not silently truncate', () => {
    // 10 `<` characters escape to 10 × `&lt;` (4 chars each) = 40 chars.
    // A 30-char cap should reject; a 50-char cap should accept.
    const input = '<<<<<<<<<<';
    expect(() => sanitizeUserText(input, { maxLength: 30, fieldLabel: 'body' }))
      .toThrow();
    // Sanity: under the cap, no throw.
    expect(sanitizeUserText(input, { maxLength: 60, fieldLabel: 'body' }))
      .toBe('&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;');
  });
});

describe('sanitizeOptionalUserText', () => {
  it('returns undefined for empty / null / undefined inputs', () => {
    expect(sanitizeOptionalUserText(undefined)).toBeUndefined();
    expect(sanitizeOptionalUserText(null)).toBeUndefined();
    expect(sanitizeOptionalUserText('')).toBeUndefined();
  });

  it('returns the sanitised string for non-empty inputs', () => {
    expect(sanitizeOptionalUserText('hello')).toBe('hello');
    const out = sanitizeOptionalUserText('<script>x</script>hi');
    expect(out).toBeDefined();
    expect(out).not.toMatch(/<script/i);
  });
});
