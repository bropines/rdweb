import { defineConfig } from "vitest/config";
// React tests opt into jsdom with a `// @vitest-environment jsdom` comment.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
