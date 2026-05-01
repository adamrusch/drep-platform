import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatWalletAddress(address: string, chars = 8): string {
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatLovelace(lovelace: string): string {
  const ada = Number(lovelace) / 1_000_000;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(ada) + ' ADA';
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function epochsToDate(epoch: number, networkEpochDurationMs = 5 * 24 * 60 * 60 * 1000): string {
  // Cardano mainnet epoch 0 started 2017-09-23T21:44:51Z
  // Preview/preprod have different genesis — this is an approximation for display
  const EPOCH_0_UNIX_MS = 1_506_203_091_000;
  const ts = EPOCH_0_UNIX_MS + epoch * networkEpochDurationMs;
  return new Date(ts).toLocaleDateString();
}
