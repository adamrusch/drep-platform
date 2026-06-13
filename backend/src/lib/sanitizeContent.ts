/**
 * Server-side input sanitization at the WRITE boundary.
 *
 * # What this module does (Sprint 4, Part B — defense in depth)
 *
 * Sanitizes user-submitted plain/markdown text BEFORE it lands on a
 * DynamoDB row. The frontend already renders markdown safely via
 * `Markdown.tsx` (react-markdown + rehype-sanitize, no
 * `dangerouslySetInnerHTML` of raw user HTML). This module is the
 * server-side belt to the client-side braces: if any future render path
 * (an SSR page, a mobile client, a third-party scrape, an email template)
 * ever stops sanitizing, the data on disk is still safe.
 *
 * # Why `xss` (and not `marked` / `DOMPurify` / `sanitize-html`)
 *
 * - `xss` is CJS-compatible at its current version. The backend tsconfig
 *   uses `module: commonjs` + `moduleResolution: node`. Pure-ESM
 *   packages like `marked` (>=12) or `DOMPurify` (>=3, in some
 *   environments) cannot be `require()`'d and would break the build.
 * - `xss` has a small surface, no dependencies, and a long track record.
 *   Project README explicitly markets it as "sanitize untrusted HTML."
 * - We use it in its STRICTEST mode: NO tags are allowed — every `<...>`
 *   is escaped to `&lt;...&gt;`. We don't store HTML; comments are plain
 *   text with markdown for FORMATTING. Markdown link/emphasis syntax
 *   does not require any HTML to round-trip.
 *
 * # Why we escape rather than strip
 *
 * Stripping `<script>...</script>` would silently delete the user's
 * text inside the tags. Escaping preserves it verbatim ("they wrote
 * `<script>`") and renders harmlessly. This matters because we host
 * security-discussion content — a user explaining "I saw a string like
 * `<script>...</script>` on a phishing site" must not have their post
 * silently truncated.
 *
 * # What this module does NOT do
 *
 * - It does NOT process markdown. The client's `Markdown.tsx` renders
 *   markdown; this module's output is still raw markdown source, just
 *   with any embedded HTML neutralized.
 * - It does NOT block legitimate markdown link syntax like
 *   `[text](javascript:alert(1))`. Markdown protocols are enforced at
 *   RENDER time by rehype-sanitize's `protocols` allow-list in
 *   `Markdown.tsx`. The corpus test (`sanitizeContent.test.ts`) asserts
 *   the markdown-link XSS vector is BLOCKED for raw HTML BUT preserved
 *   as text — the client-side filter is the second line of defense for
 *   the markdown path.
 * - It does NOT change the user's whitespace or punctuation beyond
 *   normalising NULL / control characters that could break downstream
 *   parsers.
 *
 * # Length & control-character normalisation
 *
 * `sanitizeUserText` enforces a max length (callers pass the limit they
 * want; defaults to a generous 50 000). It throws `SanitizationError`
 * if the input exceeds the cap — handlers can map that to a 400 with
 * a friendly message. Control characters in the C0 range
 * (`\x00`-`\x1F` minus `\t \n \r`) are stripped: they have no place in
 * a discussion-post body and a stray NULL can break DynamoDB query
 * paths.
 *
 * # Why every create handler routes through this module
 *
 * Sprint 4 adds calls in:
 *   - `comments/create.ts`             — governance-action comments
 *   - `clubhouse/createComment.ts`     — clubhouse comments
 *   - `clubhouse/createPost.ts`        — clubhouse posts (body + title)
 *
 * Each call site continues to do its own length / type validation
 * BEFORE calling here — the sanitiser is purely the "remove HTML
 * injection vectors" step, not a generic input validator.
 */

import { FilterXSS } from 'xss';

/**
 * The xss filter we use everywhere. Strictest possible config:
 *
 *  - `whiteList: {}`         — NO tags survive. Every `<tag>` becomes
 *                              `&lt;tag&gt;` literal text.
 *  - `stripIgnoreTag: false` — escape ignored tags rather than strip.
 *  - `stripIgnoreTagBody`    — DROP the content of dangerous-tag bodies
 *                              (`<script>steal()</script>` → "" instead
 *                              of "steal()"). This is the one place we
 *                              prefer dropping content over preserving
 *                              it, because the body of a `<script>` tag
 *                              is JS source the user almost certainly
 *                              didn't intend to share as readable text.
 *  - `allowCommentTag: false`— `<!-- ... -->` comments are escaped, not
 *                              passed through. (xss strips HTML comments
 *                              by default; this flag is here for
 *                              documentation.)
 *  - `css: false`            — never parse inline `style=` attributes
 *                              (no tags anyway, but belt + braces).
 *  - `escapeHtml`            — custom override that escapes ONLY `<`. The
 *                              `xss` default escapes `< > & " ' /` which
 *                              corrupts benign markdown source (blockquote
 *                              `>` becomes `&gt;`, an `&` in user prose
 *                              becomes `&amp;`). Since we don't allow
 *                              ANY tag through (`whiteList: {}`), the
 *                              ONLY character that can open an HTML tag
 *                              is `<`. Escaping just `<` makes markdown
 *                              source round-trip cleanly to the client
 *                              renderer while still neutralising every
 *                              tag opener. The "TEXT" pipeline of the
 *                              `xss` library — what it calls `escapeHtml`
 *                              — runs over the surviving plain-text
 *                              chunks (everything not matched as a tag).
 *                              The tag-rendering pipeline still escapes
 *                              EVERYTHING when it represents an ignored
 *                              tag (`<a>` becomes `&lt;a&gt;` regardless
 *                              of this override) — see `onIgnoreTag`
 *                              upstream. So a SAFE invariant holds:
 *                              every output of this filter is free of
 *                              `<[A-Za-z]` and `</[A-Za-z]` runs.
 */
const xssFilter = new FilterXSS({
  whiteList: {},
  stripIgnoreTag: false,
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed'],
  allowCommentTag: false,
  css: false,
  // Only escape the one byte that can open a tag. Leaves `>`, `&`, `"`,
  // `'`, `/` untouched so markdown's blockquote prefix (`>`), shell-
  // pipeline examples, contractions and ampersand-bearing prose
  // (`Q & A`, `Apple & Co`) survive intact.
  escapeHtml: (text: string): string => text.replace(/</g, '&lt;'),
});

/**
 * Thrown when sanitisation hits a hard limit (today: length cap).
 * Handlers should `catch` this and respond 400.
 */
export class SanitizationError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SanitizationError';
  }
}

export interface SanitizeOptions {
  /** Maximum length in JS string-length units AFTER sanitisation.
   *  Defaults to 50 000 — generous for a post; comment handlers
   *  enforce a tighter cap themselves before calling here. */
  maxLength?: number;
  /** Label used in the error message — e.g. `'comment body'`,
   *  `'post title'`. Surfaces in the 400 response so the user can
   *  see WHICH field exceeded the cap. */
  fieldLabel?: string;
}

/** Default cap that matches the largest existing handler ceiling
 *  (`clubhouse/createPost.ts` allows 50 000 chars). Per-handler
 *  callers should still pass their own tighter cap. */
const DEFAULT_MAX_LENGTH = 50_000;

/**
 * Sanitise a user-submitted text field. Returns the sanitised string.
 *
 * Pipeline:
 *   1. Reject non-strings (defensive — the handler already validated
 *      `typeof body === 'string'`, but this lets the helper be reused).
 *   2. Strip C0 control characters except `\t \n \r`.
 *   3. Run through `xss` with the strict no-tags whitelist — every
 *      `<tag>` becomes `&lt;tag&gt;`, dangerous tag bodies dropped.
 *   4. Enforce max length AFTER sanitisation. We measure post-escape
 *      because escaping can lengthen the string (`<` → `&lt;`); a user
 *      who hits the cap by writing all `<` characters should get a
 *      400 rather than a silent truncation.
 *
 * # Idempotence
 *
 * `sanitizeUserText(sanitizeUserText(s)) === sanitizeUserText(s)` —
 * already-escaped text round-trips unchanged. The corpus test asserts
 * this for every malicious input.
 */
export function sanitizeUserText(
  input: unknown,
  options: SanitizeOptions = {},
): string {
  if (typeof input !== 'string') {
    throw new SanitizationError(
      `${options.fieldLabel ?? 'field'} must be a string`,
    );
  }

  // Normalise C0 control characters (except tab/newline/CR). A stray
  // NULL byte from a malformed paste can corrupt downstream DDB query
  // paths; ANSI escape sequences in CloudWatch logs become a log
  // injection vector. None of these characters have a legitimate
  // place in discussion text.
  // eslint-disable-next-line no-control-regex
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization of C0 control chars
  const stripped = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const sanitized = xssFilter.process(stripped);

  const max = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (sanitized.length > max) {
    throw new SanitizationError(
      `${options.fieldLabel ?? 'field'} exceeds maximum length of ${max} characters`,
    );
  }

  return sanitized;
}

/**
 * Convenience: sanitize an optional field. Returns `undefined` when the
 * input is `undefined` / `null` / empty after sanitisation (which lets
 * handlers spread the result into an object literal with the same
 * `...(value ? { value } : {})` pattern they already use).
 */
export function sanitizeOptionalUserText(
  input: unknown,
  options: SanitizeOptions = {},
): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const out = sanitizeUserText(input, options);
  return out.length === 0 ? undefined : out;
}
