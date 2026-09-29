/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        iih: {
          green: '#16A464',
          'green-dark': '#0E7A4B',
          'green-darker': '#004225',
          'green-light': '#DFF4EA',
          light: '#f0fdf4',
          gray: '#444',
          'bg-gray': '#f4f4f4',
        },
        orbit: {
          ink: '#102018',
          'ink-soft': '#1B2F26',
          graphite: '#33423B',
          canvas: '#EDF2F0',
          surface: '#FFFFFF',
          subtle: '#F7FAF8',
          line: '#D8E2DD',
          muted: '#66736D',
          green: '#16A464',
          mint: '#DFF4EA',
          sky: '#256D85',
          'sky-soft': '#DDEEF3',
          amber: '#A06A18',
          'amber-soft': '#F7EACB',
          violet: '#57518F',
          'violet-soft': '#E8E6F5',
          danger: '#B7443E',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        /**
         * The SIWES acceptance letter, and nothing else.
         *
         * The signed template is set in Avenir Book at 12pt. That is a macOS
         * system face and is not bundled here, so the stack degrades through
         * Avenir's near relatives before reaching the app's own Plex Sans —
         * a letter printed from a Windows machine should still look like a
         * letter, not like the dashboard it was printed from.
         */
        letter: ['"Avenir Book"', 'Avenir', '"Avenir Next"', 'Nunito Sans', '"IBM Plex Sans"', 'sans-serif'],
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.625rem' }],
        '2xl': ['1.25rem', { lineHeight: '1.75rem' }],
        '3xl': ['1.5rem', { lineHeight: '2rem' }],
      },
      boxShadow: {
        'orbit-sm': '0 1px 0 rgba(16, 32, 24, 0.05)',
        'orbit-md': '0 12px 28px rgba(16, 32, 24, 0.08)',
      },
    },
  },
  plugins: [],
};
