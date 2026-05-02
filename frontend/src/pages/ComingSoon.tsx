import React from 'react';
import { Link } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

interface ComingSoonProps {
  title: string;
  description?: string;
}

/**
 * Stub landing for routes that have a sidebar entry but are not yet
 * fleshed out. Used for Committee, DReps directory, Rationales,
 * Notifications until each gets its real page.
 */
export function ComingSoon({ title, description }: ComingSoonProps): React.ReactElement {
  return (
    <div className="max-w-3xl mx-auto">
      <Card padLg className="text-center py-12">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] mb-4">
          <Construction size={24} strokeWidth={1.75} />
        </div>
        <h1 className="text-2xl font-bold mb-2 text-[var(--text-primary)]">{title}</h1>
        <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto mb-6">
          {description ?? 'This surface is part of the roadmap and will be available shortly.'}
        </p>
        <Button asChild variant="secondary">
          <Link to="/governance">Browse Governance Actions</Link>
        </Button>
      </Card>
    </div>
  );
}
