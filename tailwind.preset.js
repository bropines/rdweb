// Tailwind CSS 3 preset with the shadcn/ui theme rdweb/react is styled with:
// colors from CSS variables (HSL triplets), radius from --radius, and the
// tailwindcss-animate plugin. Used for the prebuilt dist/react/style.css and by
// the standalone app; hosts with their own shadcn/ui setup already have it.
import animate from "tailwindcss-animate";

const hsl = (name) => `hsl(var(--${name}))`;

/** @type {Partial<import("tailwindcss").Config>} */
export default {
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        border: hsl("border"),
        input: hsl("input"),
        ring: hsl("ring"),
        background: hsl("background"),
        foreground: hsl("foreground"),
        primary: { DEFAULT: hsl("primary"), foreground: hsl("primary-foreground") },
        secondary: { DEFAULT: hsl("secondary"), foreground: hsl("secondary-foreground") },
        destructive: { DEFAULT: hsl("destructive"), foreground: hsl("destructive-foreground") },
        muted: { DEFAULT: hsl("muted"), foreground: hsl("muted-foreground") },
        accent: { DEFAULT: hsl("accent"), foreground: hsl("accent-foreground") },
        popover: { DEFAULT: hsl("popover"), foreground: hsl("popover-foreground") },
        card: { DEFAULT: hsl("card"), foreground: hsl("card-foreground") },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [animate],
};
