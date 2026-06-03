/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],

  // CRITICAL: Bootstrap is already loaded globally and resets base elements
  // (body, headings, buttons, forms, etc.). If we let Tailwind's preflight run,
  // it would re-reset everything and break the rest of the app. We disable it
  // and restore only the defaults Tailwind utilities depend on (border-style,
  // box-sizing) via `[data-wizard-scope]` in src/index.css.
  corePlugins: {
    preflight: false,
  },

  theme: {
    extend: {
      // Future: lift the inline hex values used across the wizard
      // (#0b0c2a, #131c26, #5b86e5, #36d1dc, ...) into named tokens here.
      colors: {},
      animation: {},
    },
  },

  plugins: [
    require('tailwindcss-animate'),
  ],
};
