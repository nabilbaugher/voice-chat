import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sand: "#f5efe2",
        canvas: "#fffdf8",
        ink: "#241f17",
        accent: "#a0642c",
        pine: "#2f5e4a",
        line: "rgba(36, 31, 23, 0.12)"
      },
      boxShadow: {
        glow: "0 20px 60px rgba(160, 100, 44, 0.12)"
      },
      fontFamily: {
        display: ["Iowan Old Style", "Palatino Linotype", "Book Antiqua", "serif"],
        body: ["ui-sans-serif", "system-ui", "sans-serif"]
      },
      keyframes: {
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0)" },
          "50%": { transform: "translate3d(0, -8px, 0)" }
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.75", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.03)" }
        }
      },
      animation: {
        drift: "drift 7s ease-in-out infinite",
        pulseSoft: "pulseSoft 1.8s ease-in-out infinite"
      }
    }
  },
  plugins: []
} satisfies Config;
