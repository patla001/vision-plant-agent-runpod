import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        neon: {
          cyan:   "#06b6d4",
          purple: "#8b5cf6",
          green:  "#10b981",
          amber:  "#f59e0b",
        },
        surface: {
          DEFAULT: "rgba(15,23,42,0.6)",
          solid:   "#0f172a",
          dim:     "#050d14",
        },
      },
      animation: {
        "glow-pulse":    "glow-pulse 2.5s ease-in-out infinite",
        "glow-purple":   "glow-purple 2.5s ease-in-out infinite",
        "border-spin":   "border-spin 4s linear infinite",
        "blink-cursor":  "blink-cursor 1s step-end infinite",
        "float-up":      "float-up .5s ease both",
        "gradient-x":    "gradient-x 4s ease infinite",
        "scan-line":     "scan-line 3s linear infinite",
      },
      boxShadow: {
        "neon-cyan":   "0 0 20px rgba(6,182,212,.5), 0 0 60px rgba(6,182,212,.2)",
        "neon-purple": "0 0 20px rgba(139,92,246,.5), 0 0 60px rgba(139,92,246,.2)",
        "neon-green":  "0 0 20px rgba(16,185,129,.5), 0 0 60px rgba(16,185,129,.2)",
      },
    },
  },
  plugins: [],
};

export default config;
