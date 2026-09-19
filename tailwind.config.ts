import type { Config } from "tailwindcss";

export default {
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "var(--panel)",
        line: "var(--line)",
        text: "var(--text)",
        muted: "var(--muted)",
        blue: "var(--blue)",
        green: "var(--green)",
        orange: "var(--orange)",
        red: "var(--red)",
        purple: "var(--purple)"
      },
      boxShadow: {
        panel: "var(--shadow-soft)"
      }
    }
  },
  plugins: []
} satisfies Config;

