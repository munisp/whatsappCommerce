import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  // The app is built with the automatic JSX runtime (the Vite React plugin); without this vitest's esbuild compiles TSX with the
  // classic runtime and any component that does not `import React` throws "React is not defined" when a test renders it.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "simulation/**/*.test.ts", "client/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [
      // Requires a local PostgreSQL instance (localhost:5432) — skipped in sandbox/CI
      "server/postgres.connection.test.ts",
    ],
  },
});
