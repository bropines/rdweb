import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig, type Plugin } from "vite";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Which build is deployed: package version, commit and build date, shown in
// the footer and the About dialog.
function gitCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: at("."), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const BUILD = {
  version: (JSON.parse(readFileSync(at("../package.json"), "utf8")) as { version: string }).version,
  commit: gitCommit(),
  date: new Date().toISOString().slice(0, 10),
};

// Production builds only (the dev server needs inline scripts): the page may
// talk to the configured servers over WebSocket and load nothing else.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // Opus decoding via WebAssembly where WebCodecs has no audio
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' wss: ws:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "rdweb-app-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

// The standalone web client, built from the library sources (no npm package).
// GitHub Pages serves it at https://bropines.github.io/rdweb/.
export default defineConfig({
  root: at("."),
  base: "/rdweb/",
  plugins: [react(), contentSecurityPolicy()],
  define: { __RDWEB_BUILD__: JSON.stringify(BUILD) },
  resolve: {
    alias: [
      { find: /^rdweb$/, replacement: at("../src/index.ts") },
      { find: /^rdweb\/react$/, replacement: at("../src/react/index.ts") },
      { find: /^@ui\//, replacement: `${at("../src/react/ui")}/` },
    ],
  },
  css: { postcss: { plugins: [tailwindcss(at("./tailwind.config.js")), autoprefixer()] } },
  build: {
    outDir: at("./dist"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // stable vendor chunks: better caching across releases
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/](@bufbuild|tweetnacl|fzstd)[\\/]/.test(id)) return "protocol";
          // the Opus fallback decoder (WebAssembly) stays a lazily loaded chunk
          if (/[\\/]node_modules[\\/](opus-decoder|@wasm-audio-decoders)[\\/]/.test(id)) return undefined;
          if (id.includes("node_modules")) return "ui";
          return undefined;
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5200, strictPort: true },
  preview: { host: "127.0.0.1", port: 5201, strictPort: true },
});
