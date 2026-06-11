/**
 * Operator details for the legal pages (Imprint, Privacy).
 *
 * The text of these policies is public and lives in the repo. The OPERATOR
 * details (name, postal address, contact email, etc.) are personal/legal
 * data of whoever runs the deploy, and we deliberately keep them out of
 * the repo. They are injected at build time via Vite's `import.meta.env`
 * envvars, prefixed `VITE_LEGAL_*` so Vite exposes them to the client
 * bundle:
 *
 *   VITE_LEGAL_OPERATOR_NAME       operator name or entity
 *   VITE_LEGAL_OPERATOR_ADDRESS    postal address; "|" or newline separated lines
 *   VITE_LEGAL_CONTACT_EMAIL       contact email for legal/privacy requests
 *   VITE_LEGAL_RESPONSIBLE_PERSON  person responsible for content (defaults to operator)
 *   VITE_LEGAL_PHONE               optional phone number
 *   VITE_LEGAL_VAT_ID              optional VAT identification number
 *
 * Set them in the deploy environment (Vite reads them from `process.env`
 * at build time, or `.env.local` for local dev). If unset, the parser
 * returns neutral placeholders so the pages still render cleanly and
 * `configured` is false — the imprint/privacy page can show a notice
 * letting the operator know the env vars are missing without crashing.
 *
 * The pure parser is exported separately from the env reader so tests can
 * exercise every branch with a synthetic env, mirroring the DRep Talk
 * legal module that inspired this module.
 */

export interface LegalInfo {
  operatorName: string;
  addressLines: string[];
  email: string;
  phone: string | null;
  vatId: string | null;
  responsiblePerson: string;
  /** True when the three required fields (name, address, email) are all
   *  present. The pages render either way but can show an "operator hasn't
   *  configured these" notice when false. */
  configured: boolean;
}

/** Shown in place of an unconfigured field so the page is never blank.
 *  Matches the i18n string `legal.notConfigured`; tests can pin this. */
export const NOT_CONFIGURED_PLACEHOLDER = '(not configured)';

/**
 * Read the env at module-eval. Vite replaces `import.meta.env.VITE_*` with
 * literal strings at build time, so the function is dead-code-eliminated
 * in production and the returned record contains exactly the values that
 * were defined when `vite build` ran.
 *
 * Falls back to `process.env` in the Node test environment (vitest +
 * jsdom). When neither is available (e.g. SSR pre-build), returns an empty
 * record.
 */
function readEnv(): Record<string, string | undefined> {
  // `import.meta.env` is the canonical Vite path.
  try {
    const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (viteEnv) return viteEnv;
  } catch {
    // ignored — fall through to process.env
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env as Record<string, string | undefined>;
  }
  return {};
}

/** Production accessor used by the legal pages. */
export function getLegalInfo(): LegalInfo {
  return parseLegalInfo(readEnv());
}

/**
 * Pure parser — exported for tests. Takes a synthetic env (or
 * `import.meta.env` in production) and produces a fully populated
 * `LegalInfo`. Trims whitespace, splits the address on `|` or newlines,
 * defaults the responsible person to the operator, and sets `configured`
 * based on the three legally-essential fields. Never throws.
 */
export function parseLegalInfo(env: Record<string, string | undefined>): LegalInfo {
  const name = (env['VITE_LEGAL_OPERATOR_NAME'] ?? '').trim();
  const address = (env['VITE_LEGAL_OPERATOR_ADDRESS'] ?? '').trim();
  const email = (env['VITE_LEGAL_CONTACT_EMAIL'] ?? '').trim();
  const phone = (env['VITE_LEGAL_PHONE'] ?? '').trim();
  const vat = (env['VITE_LEGAL_VAT_ID'] ?? '').trim();
  const responsible = (env['VITE_LEGAL_RESPONSIBLE_PERSON'] ?? '').trim() || name;

  // Address lines may be separated by "|" or newlines. We tolerate both
  // so an operator can set the env var on one line in CI/CD ("Some Street
  // 1 | 12345 City | Germany") or as a multi-line .env value.
  const addressLines = address.split(/\s*[|\n]\s*/).filter(Boolean);

  return {
    operatorName: name || NOT_CONFIGURED_PLACEHOLDER,
    addressLines: addressLines.length ? addressLines : [NOT_CONFIGURED_PLACEHOLDER],
    email: email || NOT_CONFIGURED_PLACEHOLDER,
    phone: phone || null,
    vatId: vat || null,
    responsiblePerson: responsible || NOT_CONFIGURED_PLACEHOLDER,
    configured: Boolean(name && address && email),
  };
}
