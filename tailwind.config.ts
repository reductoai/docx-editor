import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-hover": "var(--surface-hover)",
        "surface-pressed": "var(--surface-pressed)",
        fg: "var(--fg)",
        "fg-primary": "var(--fg-primary)",
        "fg-secondary": "var(--fg-secondary)",
        "fg-disabled": "var(--fg-disabled)",
        "fg-error": "var(--fg-error)",
        "fg-inverse": "var(--fg-inverse)",
        border: "var(--border)",
        "border-subtle": "var(--border-subtle)",
        "border-hover": "var(--border-hover)",
        "border-active": "var(--border-active)",
        icon: "var(--icon)",
        "icon-hover": "var(--icon-hover)",
        "icon-disabled": "var(--icon-disabled)",
        brand: "var(--brand)",
        "brand-fg": "var(--brand-fg)",
        "brand-subtle-bg": "var(--brand-subtle-bg)",
      },
      fontFamily: {
        sans: ["Roobert", "system-ui", "sans-serif"],
        mono: ["Berkeley Mono", "ui-monospace", "monospace"],
        serif: ["Reducto Serif", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
