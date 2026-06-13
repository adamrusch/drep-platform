/**
 * Tests for the global Footer.
 *
 * Confirms the footer exposes the operational + legal links that Sprint 6
 * is built around: the data-freshness help page (internal route), the
 * imprint and privacy pages (internal routes), and SECURITY.md +
 * CONTRIBUTING.md (external github links to the repo's root files).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Footer } from './Footer';

describe('Footer', () => {
  it('renders the data-freshness link pointing at /help/data-freshness', () => {
    const { getByText } = render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    const link = getByText('Data freshness') as HTMLAnchorElement;
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/help/data-freshness');
  });

  it('renders the imprint and privacy internal route links', () => {
    const { getByText } = render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect((getByText('Imprint') as HTMLAnchorElement).getAttribute('href')).toBe('/imprint');
    expect((getByText('Privacy') as HTMLAnchorElement).getAttribute('href')).toBe('/privacy');
  });

  it('renders the SECURITY.md and CONTRIBUTING.md external links with rel=noopener', () => {
    const { getByText } = render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    const security = getByText('Security') as HTMLAnchorElement;
    const contributing = getByText('Contributing') as HTMLAnchorElement;
    expect(security.href).toMatch(/SECURITY\.md$/);
    expect(contributing.href).toMatch(/CONTRIBUTING\.md$/);
    expect(security.target).toBe('_blank');
    expect(contributing.target).toBe('_blank');
    expect(security.rel).toContain('noopener');
    expect(contributing.rel).toContain('noopener');
  });
});
