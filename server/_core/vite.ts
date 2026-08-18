import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { useBrotliPrecompression } from "./staticCompression";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

/**
 * Serve a standalone Vite app (ui/platform-admin, ui/tenant-portal) mounted
 * at `urlPrefix`, built with a matching Vite `base` so its own asset URLs
 * already carry that prefix. Registered before the main client's catch-all
 * so its own SPA fallback (not the main client's index.html) wins for
 * unmatched paths under the prefix — client-side routing still works on
 * refresh/deep-link.
 */
function serveStaticApp(app: Express, urlPrefix: string, distPath: string) {
  if (!fs.existsSync(distPath)) {
    console.error(`Could not find the build directory: ${distPath}, make sure to build ${urlPrefix} first`);
    return;
  }
  useBrotliPrecompression(app, urlPrefix, distPath);
  app.use(urlPrefix, express.static(distPath));
  app.get(`${urlPrefix}*`, (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

export function serveStatic(app: Express) {
  const isDev = process.env.NODE_ENV === "development";
  const distRoot = isDev
    ? path.resolve(import.meta.dirname, "../..", "dist")
    : path.resolve(import.meta.dirname);

  serveStaticApp(app, "/platform-admin", path.resolve(distRoot, "platform-admin"));
  serveStaticApp(app, "/tenant-portal", path.resolve(distRoot, "tenant-portal"));

  const distPath = path.resolve(distRoot, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  useBrotliPrecompression(app, "/", distPath);
  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
