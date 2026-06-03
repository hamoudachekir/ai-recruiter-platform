import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose Tailwind class names, deduplicating conflicting utilities.
 * Matches the shadcn/ui convention so future shadcn-style components drop in.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
