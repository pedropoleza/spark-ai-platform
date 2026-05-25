import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "Open Sans", "system-ui", "sans-serif"],
        // Plataforma Modular: display "Composable/Blueprint" (Bricolage Grotesque).
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        brand: {
          DEFAULT: "#1675F2",
          50: "#EBF3FE",
          100: "#D6E7FD",
          200: "#AECFFB",
          300: "#85B7F9",
          400: "#5D9FF7",
          500: "#1675F2",
          600: "#1267D8",
          700: "#0E54B0",
          800: "#0A4188",
          900: "#062E60",
        },
        // Acento "spark" (lima) — COM PARCIMÔNIA pra estados ativo/selecionado/
        // conectado na UI Composable. Pop sobre o azul estrutural.
        spark: {
          DEFAULT: "#A3E635",
          50: "#F7FEE7",
          100: "#ECFCCB",
          200: "#D9F99D",
          300: "#BEF264",
          400: "#A3E635",
          500: "#84CC16",
          600: "#65A30D",
          700: "#4D7C0F",
        },
        paper: "#FBFBF9", // superfície branco-quente
        ink: "#0F1115", // tinta
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "wizard-in": {
          from: { opacity: "0", transform: "translateY(10px) scale(0.99)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.3s ease-out",
        "wizard-in": "wizard-in 0.35s cubic-bezier(0.22,1,0.36,1)",
      },
      backgroundImage: {
        // Textura blueprint sutil (grid azul) pra fundo do wizard/composer.
        blueprint:
          "linear-gradient(rgba(22,117,242,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(22,117,242,0.045) 1px, transparent 1px)",
      },
      backgroundSize: {
        blueprint: "28px 28px",
      },
    },
  },
  plugins: [],
};
export default config;
