import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// Standalone Vite app — deliberately not wired into the existing
// server/_core/vite.ts middleware-mode dev integration used by client/, to
// avoid touching that live setup. Proxies /api to the Express server (which
// still owns all tRPC routers, auth, and session handling) during dev.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig(({ command }) => ({
  // Served at /platform-admin/* in production (the Express server hosts all
  // three apps from one origin); the standalone dev server keeps serving
  // from / so `npm run dev:platform-admin` works unprefixed.
  base: command === "build" ? "/platform-admin/" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(REPO_ROOT, "client", "src"),
      "@shared": path.resolve(REPO_ROOT, "shared"),
      "@assets": path.resolve(REPO_ROOT, "attached_assets"),
      "@ui-shared": path.resolve(REPO_ROOT, "ui", "shared"),
    },
  },
  envDir: REPO_ROOT,
  root: import.meta.dirname,
  publicDir: path.resolve(REPO_ROOT, "client", "public"),
  build: {
    outDir: path.resolve(REPO_ROOT, "dist", "platform-admin"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // === W48 perf (PERF-FE-8): split vendor deps into cacheable chunks ===
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("recharts") || id.includes("d3-")) return "vendor-charts";
          if (/node_modules\/(react|react-dom|scheduler|wouter)\//.test(id)) return "vendor-react";
          return "vendor";
        },
      },
    },
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
}));
