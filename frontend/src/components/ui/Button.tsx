import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button component matching the design system spec from
 * `design-system.css` `.btn--primary/secondary/ghost`. Uses CSS variables for
 * brand color so it tracks light / dark theme without per-variant overrides.
 */
const buttonVariants = cva(
  // Base — radius, weight, height, transitions all per design tokens
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
    'font-semibold tracking-tight',
    'transition-all duration-150 ease-out',
    'focus-visible:outline-none focus-visible:shadow-token-focus',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
    'border border-transparent',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: [
          'bg-[var(--brand-primary)] text-white shadow-token-xs',
          'hover:bg-[var(--brand-primary-hover)] hover:-translate-y-px hover:shadow-token-sm',
          'active:translate-y-0',
        ].join(' '),
        secondary: [
          'bg-[var(--bg-canvas)] text-[var(--text-primary)] border-[var(--border-default)]',
          'hover:bg-[var(--bg-muted)] hover:border-[var(--border-strong)]',
        ].join(' '),
        ghost: [
          'bg-transparent text-[var(--text-secondary)]',
          'hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]',
        ].join(' '),
        destructive: [
          'bg-[var(--danger)] text-white shadow-token-xs',
          'hover:bg-[var(--danger)] hover:opacity-90 hover:-translate-y-px hover:shadow-token-sm',
          'active:translate-y-0',
        ].join(' '),
        link: [
          'bg-transparent text-[var(--brand-primary)] h-auto p-0',
          'hover:underline',
        ].join(' '),
      },
      size: {
        default: 'h-[38px] px-4 text-[13.5px] rounded-token-md',
        sm: 'h-8 px-3 text-[12.5px] rounded-token-md',
        xs: 'h-[26px] px-2.5 text-xs rounded-token-md',
        lg: 'h-11 px-6 text-sm rounded-token-md',
        icon: 'h-[38px] w-[38px] rounded-token-md',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
