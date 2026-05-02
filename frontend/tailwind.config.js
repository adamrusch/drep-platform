/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        cardano: {
          blue: 'var(--brand-primary)',
          navy: '#1A1F3E',
          teal: '#00CCCC',
        },
        brand: {
          primary: 'var(--brand-primary)',
          'primary-hover': 'var(--brand-primary-hover)',
          'primary-soft': 'var(--brand-primary-soft)',
          accent: 'var(--brand-accent)',
          'accent-soft': 'var(--brand-accent-soft)',
          cyan: 'var(--brand-cyan)',
        },
        // Direct token aliases — bridge CSS vars into utility classes
        'brand-primary': 'var(--brand-primary)',
        'brand-primary-hover': 'var(--brand-primary-hover)',
        'brand-primary-soft': 'var(--brand-primary-soft)',
        'brand-accent': 'var(--brand-accent)',
        'brand-accent-soft': 'var(--brand-accent-soft)',
        success: {
          DEFAULT: 'var(--success)',
          soft: 'var(--success-soft)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          soft: 'var(--danger-soft)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          soft: 'var(--warning-soft)',
        },
        info: {
          DEFAULT: 'var(--info)',
          soft: 'var(--info-soft)',
        },
        'success-soft': 'var(--success-soft)',
        'danger-soft': 'var(--danger-soft)',
        'warning-soft': 'var(--warning-soft)',
        'info-soft': 'var(--info-soft)',
        // Surface tokens
        'bg-app': 'var(--bg-app)',
        'bg-canvas': 'var(--bg-canvas)',
        'bg-subtle': 'var(--bg-subtle)',
        'bg-muted': 'var(--bg-muted)',
        // Text tokens
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-muted': 'var(--text-muted)',
        // Border tokens
        'border-default': 'var(--border-default)',
        'border-strong': 'var(--border-strong)',
        'border-subtle': 'var(--border-subtle)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        'token-sm': 'var(--r-sm)',
        'token-md': 'var(--r-md)',
        'token-lg': 'var(--r-lg)',
        'token-xl': 'var(--r-xl)',
        'token-2xl': 'var(--r-2xl)',
        'token-full': 'var(--r-full)',
      },
      boxShadow: {
        'token-xs': 'var(--shadow-xs)',
        'token-sm': 'var(--shadow-sm)',
        'token-md': 'var(--shadow-md)',
        'token-lg': 'var(--shadow-lg)',
        'token-focus': 'var(--shadow-focus)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('tailwindcss-animate'),
  ],
};
