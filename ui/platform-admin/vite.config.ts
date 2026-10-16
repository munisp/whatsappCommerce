import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
  plugins: [
    react(),
    tailwindcss(),
    // === W55 pwa (MOB-4/MOB-5): installable platform-admin + offline shell ===
    // Desktop back-office primarily, but installability is free: inline
    // manifest scoped to the /platform-admin/ base; SW registered in
    // src/main.tsx. Icons reuse the shared client/public/icons assets.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["offline.html", "icons/*.png"],
      manifest: {
        name: "WA Commerce — Platform Admin",
        short_name: "Platform Admin",
        description: "Platform administration: tenants, users, infrastructure, and configuration.",
        start_url: command === "build" ? "/platform-admin/" : "/",
        scope: command === "build" ? "/platform-admin/" : "/",
        display: "standalone",
        background_color: "#09090b",
        theme_color: "#22c55e",
        categories: ["business", "productivity"],
        icons: [
          { src: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable any" },
          { src: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable any" },
        ],
      },
      workbox: {
        navigateFallback: `${command === "build" ? "/platform-admin" : ""}/offline.html`,
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.(?:woff2|js|css)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "w55-static-assets",
              expiration: { maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // MOB-5: safe read-only tRPC GET queries only (mutations are POST).
            urlPattern: /\/api\/trpc\/[\w.]+/,
            method: "GET",
            handler: "NetworkFirst",
            options: {
              cacheName: "w55-api-reads",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 128, maxAgeSeconds: 5 * 60 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
