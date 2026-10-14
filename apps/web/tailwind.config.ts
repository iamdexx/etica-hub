import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2f7d5a',
          accent: '#55c28a',
          ink: '#0b1f17',
          glow: '#7fe3b0',
        },
        ink: {
          950: '#030705',
          900: '#050b08',
          800: '#08120d',
          700: '#0c1a13',
          600: '#11241b',
        },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        eyebrow: '0.18em',
      },
      boxShadow: {
        card: 'inset 0 1px 0 0 rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.4), 0 24px 60px -32px rgba(0,0,0,0.9)',
        'card-hover':
          'inset 0 1px 0 0 rgba(255,255,255,0.08), 0 2px 6px rgba(0,0,0,0.45), 0 32px 80px -36px rgba(85,194,138,0.35)',
        glow: '0 0 0 1px rgba(85,194,138,0.35), 0 0 32px -4px rgba(85,194,138,0.45)',
        'glow-sm': '0 0 0 1px rgba(85,194,138,0.25), 0 0 18px -6px rgba(85,194,138,0.5)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #7fe3b0 0%, #55c28a 45%, #2f7d5a 100%)',
        'surface-gradient':
          'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.012) 100%)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'spin-slow': { to: { transform: 'rotate(360deg)' } },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.8' },
          '100%': { transform: 'scale(1.8)', opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'menu-in': {
          '0%': { opacity: '0', transform: 'translateY(-6px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'sheet-in': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.5s ease-out both',
        'spin-slow': 'spin-slow 48s linear infinite',
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0.2, 0.7, 0.3, 1) infinite',
        shimmer: 'shimmer 2.2s linear infinite',
        'menu-in': 'menu-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) both',
        'sheet-in': 'sheet-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [typography],
};

export default config;
