import type { Config } from 'tailwindcss';

/**
 * Ops-console tokens.
 *
 * Surfaces step up in three levels (app -> card -> inset) so depth reads without
 * heavy shadows. Signal colours are semantic and never decorative:
 *   ok    permitted, active, healthy
 *   warn  approaching a ceiling
 *   bad   refused, revoked, error
 *   info  neutral emphasis
 * Each agent type also carries its own hue, so a type is recognisable in a dense
 * table without reading the label.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#0A0D13',
        surface: '#12171F',
        surfaceHi: '#171D26',
        inset: '#0D1219',
        line: '#222A36',
        lineHi: '#2E3742',

        text: '#E7EAEF',
        soft: '#94A0B0',
        faint: '#67727F',

        ok: '#22C55E',
        okDim: '#22C55E1F',
        warn: '#F59E0B',
        warnDim: '#F59E0B1F',
        bad: '#EF4444',
        badDim: '#EF44441F',
        info: '#3B82F6',
        infoDim: '#3B82F61F',

        // Per agent type
        fee: '#60A5FA',
        dispute: '#FBBF24',
        claim: '#34D399',
      },
      fontFamily: {
        sans: [
          'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI',
          'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif',
        ],
        mono: [
          'ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo',
          'Consolas', 'Liberation Mono', 'monospace',
        ],
      },
      fontSize: {
        label: ['10.5px', { lineHeight: '14px', letterSpacing: '0.09em' }],
        xs2: ['11.5px', { lineHeight: '16px' }],
        kpi: ['38px', { lineHeight: '44px', letterSpacing: '-0.025em' }],
      },
      borderRadius: { card: '12px', ctl: '8px' },
      boxShadow: {
        card: '0 1px 2px 0 #00000040',
        pop: '0 16px 48px -16px #000000e0',
        glowBad: '0 0 0 1px #EF444433, 0 0 40px -12px #EF444455',
      },
      keyframes: {
        rise: { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'none' } },
        slideIn: { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'none' } },
        breathe: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
        shimmer: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(200%)' } },
        drawIn: { '0%': { strokeDashoffset: '1' }, '100%': { strokeDashoffset: '0' } },
      },
      animation: {
        rise: 'rise 220ms ease-out',
        slideIn: 'slideIn 240ms cubic-bezier(.22,.61,.36,1)',
        breathe: 'breathe 2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
