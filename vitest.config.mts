import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here("."),
      // Without this, importing any server module under Vitest resolves the
      // client-side guard and throws before a test can run.
      "server-only": here("./tests/stubs/server-only.ts"),
    },
  },
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
