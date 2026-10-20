import { fileURLToPath } from "node:url";

import preset from "../tailwind.preset.js";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));

/** @type {import("tailwindcss").Config} */
export default {
  presets: [preset],
  content: [at("./index.html"), at("./src/**/*.{ts,tsx}"), at("../src/react/**/*.{ts,tsx}")],
};
