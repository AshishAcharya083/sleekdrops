/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        mist: '#e2e8f0',
        summit: '#0b5fff',
        alpine: '#dbecff',
        ember: '#f97316',
        pine: '#14532d',
      },
      boxShadow: {
        card: '0 20px 45px -30px rgba(15, 23, 42, 0.45)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui'],
        body: ['"Manrope"', 'ui-sans-serif', 'system-ui'],
      },
      maxWidth: {
        reading: '72ch',
      },
    },
  },
  plugins: [],
};
