/**
 * Tests for the /privacy page.
 *
 * Mirror the ImprintPage tests in shape: confirm the page renders cleanly
 * with and without env vars and that the controller block contains either
 * placeholders or the configured values. The full policy text comes from
 * the i18n bundle; we just spot-check the section headings to make sure
 * the structure didn't drop a block in a future refactor.
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

import { PrivacyPage } from './PrivacyPage';

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
    email: 'privacy@drep.tools',
    phone: null,
    vatId: null,
    responsiblePerson: 'Adam Rusch',
    configured: true,
  };
}

describe('PrivacyPage (unconfigured env)', () => {
  it('renders without crashing and surfaces the "not configured" notice', () => {
    mockGetLegalInfo.mockReturnValue(unconfigured());
    const { getByTestId, getByRole } = render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );
    expect(getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(getByTestId('legal-not-configured')).toBeInTheDocument();
  });

  it('renders placeholder controller block instead of crashing', () => {
    mockGetLegalInfo.mockReturnValue(unconfigured());
    const { getByTestId } = render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );
    const controller = getByTestId('privacy-controller');
    expect(controller.textContent).toContain(NOT_CONFIGURED_PLACEHOLDER);
  });
});

describe('PrivacyPage (configured env)', () => {
  it('renders the controller block with configured values', () => {
    mockGetLegalInfo.mockReturnValue(configured());
    const { getByTestId, queryByTestId, getAllByText } = render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );
    expect(queryByTestId('legal-not-configured')).toBeNull();
    const controller = getByTestId('privacy-controller');
    expect(controller.textContent).toContain('Adam Rusch');
    expect(controller.textContent).toContain('123 Elm St');
    // The email appears at least twice (controller block + Your Rights body),
    // each rendered as a mailto link.
    const emailLinks = getAllByText('privacy@drep.tools');
    expect(emailLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of emailLinks) {
      expect(link.tagName).toBe('A');
      expect((link as HTMLAnchorElement).href).toBe('mailto:privacy@drep.tools');
    }
  });
});
