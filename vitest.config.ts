import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// React tests opt into jsdom with a `// @vitest-environment jsdom` comment.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    // the standalone app (app/) imports the library by name
    alias: [
      { find: /^rdweb$/, replacement: at("./src/index.ts") },
      { find: /^rdweb\/react$/, replacement: at("./src/react/index.ts") },
    ],
  },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
