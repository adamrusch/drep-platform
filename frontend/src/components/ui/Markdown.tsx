import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import { cn } from '@/lib/utils';

/**
 * Markdown renderer for untrusted CIP-100 / CIP-108 anchor body fields.
 *
 * Anchor metadata flows from arbitrary IPFS / HTTP URLs and is fetched by
 * the sync without authoring controls — it MUST be treated as user input.
 * react-markdown + rehype-sanitize is the standard React-side pattern:
 * Markdown is parsed into a hast tree, rehype-sanitize drops scripts,
 * `on*` event handlers, and dangerous URI schemes (javascript:, data:),
 * and only then is the tree turned into React elements. Crucially we never
 * touch `dangerouslySetInnerHTML` — the HTML in the source string never
 * becomes live HTML.
 *
 * Allowed link schemes: http, https, ipfs (matches the existing
 * `isSafeReferenceUri` allow-list on the governance detail page). We
 * deliberately drop `mailto:` and `xmpp:` from rehype-sanitize's defaults
 * — those have no business in a CIP anchor body.
 *
 * Styling: tries to match the rest of the governance detail page. The
 * top-level wrapper has `prose-token` styling (small body text, comfortable
 * line height, brand-color links). Headings are sized down so an H1
 * inside a Card doesn't dominate the page.
 *
 * Safety verification: try rendering `<script>alert(1)</script>` as input.
 * The sanitizer drops the `<script>` tag so the literal text appears, no
 * script executes. (See unit-test ergonomics — exposed as a default export
 * for consumers; can be wrapped with React Testing Library.)
 */
interface MarkdownProps {
  /** Raw markdown text (treated as untrusted). */
  children: string;
  className?: string;
}

/** Restrict `href` to http(s) and ipfs only — no mailto:, no data:,
 *  no javascript:. Mirror this in the `src` for images too. */
const SAFE_HREF_PROTOCOLS = ['http', 'https', 'ipfs'];
const SAFE_SRC_PROTOCOLS = ['http', 'https', 'ipfs'];

const sanitizeOptions: SanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: SAFE_HREF_PROTOCOLS,
    src: SAFE_SRC_PROTOCOLS,
    cite: ['http', 'https'],
    longDesc: ['http', 'https'],
  },
};

/** Custom renderers that match our design tokens. We avoid global CSS so
 *  the markdown styling lives next to the component (easy to audit). */
const components: Components = {
  // Headings — sized down so H1 inside a Card doesn't compete with the
  // page title. The hierarchy is preserved with weight + size deltas.
  h1: ({ children, ...props }) => (
    <h3
      className="text-[16px] font-bold text-[var(--text-primary)] mt-4 mb-2 first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h2: ({ children, ...props }) => (
    <h4
      className="text-[15px] font-semibold text-[var(--text-primary)] mt-4 mb-2 first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  h3: ({ children, ...props }) => (
    <h5
      className="text-[14px] font-semibold text-[var(--text-primary)] mt-3 mb-1.5 first:mt-0"
      {...props}
    >
      {children}
    </h5>
  ),
  h4: ({ children, ...props }) => (
    <h6
      className="text-[13.5px] font-semibold text-[var(--text-primary)] mt-3 mb-1.5 first:mt-0"
      {...props}
    >
      {children}
    </h6>
  ),
  h5: ({ children, ...props }) => (
    <h6
      className="text-[13px] font-semibold text-[var(--text-secondary)] mt-3 mb-1 first:mt-0"
      {...props}
    >
      {children}
    </h6>
  ),
  h6: ({ children, ...props }) => (
    <p className="text-[13px] font-semibold text-[var(--text-secondary)] mt-3 mb-1 first:mt-0" {...props}>
      {children}
    </p>
  ),
  p: ({ children, ...props }) => (
    <p
      className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3 last:mb-0"
      {...props}
    >
      {children}
    </p>
  ),
  a: ({ children, href, ...props }) => (
    // Links: brand-color, underline on hover, always open in a new tab
    // with rel=noopener noreferrer so the target page can't access window.opener.
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--brand-primary)] hover:underline break-all"
      {...props}
    >
      {children}
    </a>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className="list-disc list-outside pl-5 my-3 text-sm text-[var(--text-secondary)] leading-relaxed space-y-1"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className="list-decimal list-outside pl-5 my-3 text-sm text-[var(--text-secondary)] leading-relaxed space-y-1"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="text-sm text-[var(--text-secondary)]" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-[var(--text-primary)]" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="border-l-4 border-[var(--border-default)] pl-4 my-3 text-sm text-[var(--text-tertiary)] italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  // Inline code vs. fenced code — we distinguish by the `inline` flag that
  // react-markdown sets on the renderer. The default renderer uses the
  // same component for both; we branch here so they look different.
  code: ({ className, children, ...props }) => {
    // Fenced code blocks come with a language- class; inline code does not.
    // (react-markdown v9 dropped the explicit `inline` boolean prop in
    // favor of structural detection — block code is always wrapped in a
    // <pre>, so we can detect block vs. inline via the `node`/parent in
    // a renderer override; here we keep it simple by checking for the
    // language class + assuming uncoloured snippets are inline.)
    const isBlock = typeof className === 'string' && className.startsWith('language-');
    if (isBlock) {
      return (
        <code
          className="font-mono text-[12.5px] text-[var(--text-primary)]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="font-mono text-[12.5px] bg-[var(--bg-muted)] text-[var(--text-primary)] rounded-token-sm px-1 py-0.5"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-token-md p-3 my-3 text-[12.5px] overflow-x-auto leading-relaxed"
      {...props}
    >
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-[var(--border-subtle)]" />,
  // Tables (gfm) — keep them styled minimally so they fit the card.
  table: ({ children, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className="text-sm border-collapse" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="border border-[var(--border-subtle)] px-2 py-1 text-left font-semibold text-[var(--text-primary)]"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      className="border border-[var(--border-subtle)] px-2 py-1 text-[var(--text-secondary)]"
      {...props}
    >
      {children}
    </td>
  ),
  // Disable images by default — anchor bodies almost never include images
  // and shipping arbitrary remote `<img>` tags is a privacy / fingerprinting
  // surface we don't need. If a future feature wants images, replace this
  // with a whitelist of trusted hosts.
  img: () => null,
};

export function Markdown({ children, className }: MarkdownProps): React.ReactElement {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeOptions]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
