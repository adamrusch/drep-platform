/**
 * Tests for the /imprint page.
 *
 * The page renders operator details from `VITE_LEGAL_*` env vars. These
 * tests confirm:
 *
 *   - The page renders cleanly when the env vars are unset (placeholders
 *     appear, no crash, and the operator sees a "not configured" notice).
 *   - The page renders configured values when the env vars are set
 *     (operator name, address, email all appear).
 *
 * We exercise the env-driven branches by stubbing the `getLegalInfo`
 * accessor at the module boundary — the pure parser is tested separately
 * in `legal.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NOT_CONFIGURED_PLACEHOLDER, type LegalInfo } from '@/lib/legal';

const mockGetLegalInfo = vi.fn();

vi.mock('@/lib/legal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/legal')>();
  return {
    ...actual,
    getLegalInfo: () => mockGetLegalInfo(),
  };
});

import { ImprintPage } from './ImprintPage';

afterEach(() => {
  mockGetLegalInfo.mockReset();
});

function unconfigured(): LegalInfo {
  return {
    operatorName: NOT_CONFIGURED_PLACEHOLDER,
    addressLines: [NOT_CONFIGURED_PLACEHOLDER],
    email: NOT_CONFIGURED_PLACEHOLDER,
    phone: null,
    vatId: null,
    responsiblePerson: NOT_CONFIGURED_PLACEHOLDER,
    configured: false,
  };
}

function configured(): LegalInfo {
  return {
    operatorName: 'Adam Rusch',
    addressLines: ['123 Elm St', 'Urbana, IL 61801', 'USA'],
    email: 'legal@drep.tools',
    phone: '+1 555 0100',
    vatId: null,
    responsiblePerson: 'Adam Rusch',
    configured: true,
  };
}

describe('ImprintPage (unconfigured env)', () => {
  it('renders without crashing and surfaces the "not configured" notice', () => {
    mockGetLegalInfo.mockReturnValue(unconfigured());
    const { getByTestId, getByRole } = render(
      <MemoryRouter>
        <ImprintPage />
      </MemoryRouter>,
    );
    expect(getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(getByTestId('legal-not-configured')).toBeInTheDocument();
  });

  it('shows placeholder operator block instead of crashing on missing values', () => {
    mockGetLegalInfo.mockReturnValue(unconfigured());
    const { getByTestId } = render(
      <MemoryRouter>
        <ImprintPage />
      </MemoryRouter>,
    );
    const operator = getByTestId('imprint-operator');
    expect(operator.textContent).toContain(NOT_CONFIGURED_PLACEHOLDER);
  });
});

describe('ImprintPage (configured env)', () => {
  it('renders the operator name, address lines, and email', () => {
    mockGetLegalInfo.mockReturnValue(configured());
    const { getByTestId, queryByTestId, getByText } = render(
      <MemoryRouter>
        <ImprintPage />
      </MemoryRouter>,
    );
    // No "not configured" notice when the operator filled the env vars.
    expect(queryByTestId('legal-not-configured')).toBeNull();
    const operator = getByTestId('imprint-operator');
    expect(operator.textContent).toContain('Adam Rusch');
    expect(operator.textContent).toContain('123 Elm St');
    expect(operator.textContent).toContain('Urbana, IL 61801');
    // The email renders as a mailto link.
    const email = getByText('legal@drep.tools');
    expect(email).toBeInTheDocument();
    expect(email.tagName).toBe('A');
    expect((email as HTMLAnchorElement).href).toBe('mailto:legal@drep.tools');
  });
});
