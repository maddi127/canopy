/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canopy: {
          600: "#2F6B4F",
          500: "#3E7C5D",
          400: "#5F9B7B",
          100: "#E7F2EC",
        },
        soil: {
          900: "#2A2A26",
          700: "#4B4B45",
          500: "#7A7A73",
          300: "#C9C8C2",
          100: "#F5F4F1",
        },
        sky: "#5DA9E9",
        sun: "#F4C95D",
        clay: "#C77C5B",
        leaf: "#6FBF73",
        // Functional colors
        success: "#4CAF50",
        warning: "#E8A23C",
        error: "#D65C5C",
        info: "#5DA9E9",
      },
      fontFamily: {
        sans: ['National Park', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        'canopy': '16px',
        'canopy-sm': '12px',
      },
      boxShadow: {
        'canopy': '0 4px 16px rgba(0, 0, 0, 0.05)',
        'canopy-lg': '0 8px 24px rgba(0, 0, 0, 0.08)',
      },
    },
  },
  plugins: [],
}
