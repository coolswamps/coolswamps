/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Scientific / wetland palette
        swamp: {
          50:  '#f0f7f4',
          100: '#d9ede5',
          200: '#b3dbcb',
          300: '#7fc2a8',
          400: '#4da484',
          500: '#2d8a6a',
          600: '#1e6e53',
          700: '#185843',
          800: '#144636',
          900: '#0f3328', // deep forest
          950: '#071a14',
        },
        teal: {
          400: '#40916C',
          500: '#2D6A4F',
          600: '#1B4332',
        },
        slate: {
          850: '#1a2332',
        },
        data: {
          blue: '#1d4ed8',
          amber: '#b45309',
        }
      },
      fontFamily: {
        sans: ['Inter', 'Source Sans Pro', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '75ch',
          }
        }
      }
    },
  },
  plugins: [],
};
