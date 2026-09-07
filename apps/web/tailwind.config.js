/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#f8f7f5',
        surface: '#ffffff',
        'surface-secondary': '#f0eeeb',
        accent: '#B4936F',
        'accent-hover': '#a07e5c',
        text: '#1a1a1a',
        'text-muted': '#8a8680',
        success: '#3a8a5c',
        error: '#c45c5c',
        warning: '#d4a05b',
        info: '#5b9fd4',
        border: 'rgba(0,0,0,0.08)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tight: '-0.02em',
        normal: '0',
        wide: '0.02em',
      },
    },
  },
  plugins: [],
};