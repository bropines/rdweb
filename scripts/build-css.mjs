// Builds dist/react/style.css: Tailwind utilities used by src/react plus the
// shadcn/ui theme variables and a scoped base, for hosts without Tailwind.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import autoprefixer from "autoprefixer";
import postcss from "postcss";
import tailwind from "tailwindcss";

import preset from "../tailwind.preset.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "src/react/style.css");
const to = resolve(root, "dist/react/style.css");
const SCOPE = ".rdweb";

// With preflight off, Tailwind's base layer still sets its --tw-* defaults on
// every element of the page; keep them inside rdweb's roots.
const scopeTailwindDefaults = {
  postcssPlugin: "rdweb-scope-tailwind-defaults",
  Rule(rule) {
    const sel = rule.selector.replace(/\s+/g, "");
    if (sel === "*,::before,::after") {
      rule.selector = [SCOPE, `${SCOPE} *`, `${SCOPE}::before`, `${SCOPE}::after`, `${SCOPE} ::before`, `${SCOPE} ::after`].join(",\n");
    } else if (sel === "::backdrop") {
      rule.selector = `${SCOPE}::backdrop,\n${SCOPE} ::backdrop`;
    }
  },
};

const config = {
  presets: [preset],
  content: [resolve(root, "src/react/**/*.{ts,tsx}"), `!${resolve(root, "src/react/i18n/**")}`],
  corePlugins: { preflight: false },
};

const css = await readFile(from, "utf8");
const out = await postcss([tailwind(config), scopeTailwindDefaults, autoprefixer()]).process(css, { from, to });
for (const w of out.warnings()) console.warn(w.toString());
await mkdir(dirname(to), { recursive: true });
await writeFile(to, `/*! rdweb/react styles (MIT). Includes Tailwind CSS (MIT, Tailwind Labs). */\n${out.css}`);
console.log(`wrote ${to} (${(out.css.length / 1024).toFixed(1)} KiB)`);
