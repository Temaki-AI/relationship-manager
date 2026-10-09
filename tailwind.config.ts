import type { Config } from "tailwindcss";
import { motion, radii, typeScale } from './packages/design/src/tokens';

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./packages/design/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontSize: {
        '3xl': [`${typeScale.title.fontSize}px`, { lineHeight: `${typeScale.title.lineHeight}px`, letterSpacing: `${typeScale.title.letterSpacing}px` }],
        xl: [`${typeScale.section.fontSize}px`, { lineHeight: `${typeScale.section.lineHeight}px` }],
        base: [`${typeScale.body.fontSize}px`, { lineHeight: `${typeScale.body.lineHeight}px` }],
      },
      colors: {
        success: { DEFAULT: 'hsl(var(--success))', soft: 'hsl(var(--success-soft))' },
        warning: { DEFAULT: 'hsl(var(--warning))', soft: 'hsl(var(--warning-soft))' },
        info: { DEFAULT: 'hsl(var(--info))', soft: 'hsl(var(--info-soft))' },
        'danger-soft': 'hsl(var(--danger-soft))',
        'rose-soft': 'hsl(var(--rose-soft))', 'rose-ink': 'hsl(var(--rose-ink))',
        'sage-soft': 'hsl(var(--sage-soft))', 'sage-ink': 'hsl(var(--sage-ink))',
        'peach-soft': 'hsl(var(--peach-soft))', 'peach-ink': 'hsl(var(--peach-ink))',
        'lavender-soft': 'hsl(var(--lavender-soft))', 'lavender-ink': 'hsl(var(--lavender-ink))',
        'sky-soft': 'hsl(var(--sky-soft))', 'sky-ink': 'hsl(var(--sky-ink))',
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: `${radii.card}px`,
        '2xl': `${radii.dialog}px`,
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        overlay: 'var(--shadow-overlay)',
      },
      transitionDuration: { DEFAULT: `${motion.standard}ms` },
      animation: {
        'fade-in-up': `fade-in-up ${motion.enter}ms ease-out forwards`,
        'fade-in': `fade-in ${motion.enter}ms ease-out forwards`,
        'scale-in': `scale-in ${motion.enter}ms ease-out forwards`,
        'health-fill': 'health-fill 0.8s ease-out forwards',
        'slide-down': `slide-down ${motion.enter}ms ease-out forwards`,
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'health-fill': {
          from: { width: '0%' },
        },
        'slide-down': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
