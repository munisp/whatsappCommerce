/**
 * Bundle code-splitting sanity (wave-10): the client entry must stay lean.
 *
 *  - App.tsx lazy-loads non-essential routes (React.lazy + Suspense) while
 *    keeping the shell routes (Home/Dashboard/login/404) eager.
 *  - vite.config manualChunks pins heavy vendor stacks (maplibre, recharts,
 *    react core) into named vendor chunks so route chunks stay cacheable and
 *    the map/chart code is only fetched by routes that import it.
 *
 * These are static source-level guards: they fail the moment someone
 * re-imports a heavy page eagerly or drops a vendor chunk mapping.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const appSrc = readFileSync(path.join(root, "client/src/App.tsx"), "utf8");
const viteSrc = readFileSync(path.join(root, "vite.config.ts"), "utf8");

describe("client bundle code-splitting", () => {
  it("heavy routes are lazy-loaded, not statically imported", () => {
    for (const page of ["LiveLogisticsMap", "OnboardingCopilot", "AdminPortal", "MLOpsDashboard"]) {
      expect(appSrc, `${page} must be lazy`).toContain(`const ${page} = lazy(`);
      expect(appSrc, `${page} must NOT be a static import`).not.toMatch(
        new RegExp(`^import ${page} from`, "m"),
      );
    }
  });

  it("shell routes stay eager (dashboard, home, login, 404)", () => {
    for (const page of ["Dashboard", "Home", "PortalMagicLogin", "NotFound"]) {
      expect(appSrc, `${page} must be a static import`).toMatch(new RegExp(`^import ${page} from`, "m"));
    }
  });

  it("lazy routes render inside a Suspense boundary with a fallback", () => {
    expect(appSrc).toContain("<Suspense fallback=");
    expect(appSrc).toContain("RouteFallback");
  });

  it("every lazy page is registered on a Route (no dead lazy chunks)", () => {
    const lazyNames = [...appSrc.matchAll(/^const (\w+) = lazy\(\(\) => import/gm)].map((m) => m[1]);
    expect(lazyNames.length).toBeGreaterThan(50);
    for (const name of lazyNames) {
      // Declared once, used at least once more (Route component or inline wrapper).
      const uses = appSrc.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      expect(uses, `${name} must be referenced by a route`).toBeGreaterThanOrEqual(2);
    }
  });

  it("vite manualChunks pins vendor-react, vendor-map and vendor-charts", () => {
    expect(viteSrc).toContain('"vendor-map"');
    expect(viteSrc).toContain('"vendor-charts"');
    expect(viteSrc).toContain('"vendor-react"');
    expect(viteSrc).toContain("maplibre-gl");
    expect(viteSrc).toContain("recharts");
  });
});
