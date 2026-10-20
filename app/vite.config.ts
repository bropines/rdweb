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
const version = (JSON.parse(readFileSync(at("../package.json"), "utf8")) as { version: string }).version;
const commit = gitCommit();
const date = new Date().toISOString().slice(0, 10);
// `id` names the service worker's cache; the page compares it with a waiting worker.
const BUILD = { version, commit, date, id: `${version}-${commit.slice(0, 12) || date}` };

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

// The service worker (app/sw.js) for installs and offline starts, tied to this
// build: its cache is named after BUILD.id and it precaches the app shell
// (index.html and what it loads up front). Lazy chunks (xterm.js, the terminal
// font, the Opus decoder) are cached when first used.
function serviceWorker(): Plugin {
  return {
    name: "rdweb-app-sw",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const shell = new Set<string>();
      const add = (name: string) => {
        const file = bundle[name];
        if (!file || shell.has(name)) return;
        shell.add(name);
        if (file.type !== "chunk") return;
        file.imports.forEach(add);
        file.viteMetadata?.importedCss.forEach(add);
        file.viteMetadata?.importedAssets.forEach(add);
      };
      for (const file of Object.values(bundle)) if (file.type === "chunk" && file.isEntry) add(file.fileName);
      if (shell.size === 0) this.error("service worker: no entry chunk to precache");
      const precache = ["./", "favicon.svg", ...[...shell].sort()];
      const template = readFileSync(at("./sw.js"), "utf8");
      const source = template.replace('"__RDWEB_SW_VERSION__"', JSON.stringify(BUILD.id)).replace('["__RDWEB_PRECACHE__"]', JSON.stringify(precache));
      if (source.includes("__RDWEB_")) this.error("service worker: placeholders in app/sw.js were not replaced");
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// The standalone web client, built from the library sources (no npm package).
// GitHub Pages serves it at https://bropines.github.io/rdweb/.
export default defineConfig({
  root: at("."),
  base: "/rdweb/",
  plugins: [react(), contentSecurityPolicy(), serviceWorker()],
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
          // the Opus fallback decoder (WebAssembly) and xterm.js stay lazily loaded chunks
          if (/[\\/]node_modules[\\/](opus-decoder|@wasm-audio-decoders|@xterm)[\\/]/.test(id)) return undefined;
          if (id.includes("node_modules")) return "ui";
          return undefined;
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5200, strictPort: true },
  preview: { host: "127.0.0.1", port: 5201, strictPort: true },
});
