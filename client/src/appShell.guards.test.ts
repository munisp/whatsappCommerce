/**
 * QA-043: guards for the CLASSES of bug that produced the 403s and the sidebar-less pages, so a new page or a new app cannot
 * quietly bring them back. These read source on purpose — each is about something that is NOT visible at runtime until a real
 * user hits it (a provider that isn't mounted, a tenant id baked into a page, a route with no layout).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Code only: this scan is about literals that are SENT, and my own explanatory comments name the very strings it forbids. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(tsx?)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(f);
  }
  return out;
}

describe("every app that renders tenant-scoped pages mounts the TenantProvider", () => {
  // ui/tenant-portal never did: `useActiveTenant()` then returned the context default — the demo tenant "tenant-001" — with a
  // no-op setter, and 24 of its pages sent it on every query. The server refused each with a 403 for every real merchant.
  it.each(["client/src/main.tsx", "ui/tenant-portal/src/main.tsx", "ui/platform-admin/src/main.tsx"])("%s", (main) => {
    const src = read(main);
    expect(src).toMatch(/import \{ TenantProvider \} from "(@|\.)\/?[^"]*contexts\/TenantContext"/);
    expect(src).toMatch(/<TenantProvider>/);
    expect(src.indexOf("<TenantProvider>"), "must sit inside the QueryClientProvider (it calls useAuth)").toBeGreaterThan(src.indexOf("<QueryClientProvider"));
  });

  it("the context's built-in default is NO tenant (so a missing provider fails closed, not as the demo tenant)", () => {
    const src = read("client/src/contexts/TenantContext.tsx");
    expect(src).toMatch(/createContext<TenantContextType>\(\{\s*activeTenantId: "",/);
  });
});

describe("no page hard-codes a tenant id", () => {
  // Eleven pages did ("default", "demo-tenant-1", "tenant-001"): each sent someone else's id and was refused (403) for every real tenant.
  const ALLOWED = new Set([
    "client/src/contexts/TenantContext.tsx", // the platform ADMIN's starting selection, never used for anyone else
    "client/src/pages/NLPSimulator.tsx", // an admin simulator whose dropdown lists the demo tenants on purpose
  ]);
  const files = [...walk(join(ROOT, "client/src")), ...walk(join(ROOT, "ui"))].filter((f) => !f.includes("/node_modules/"));

  it("is not vacuous: it scans the pages", () => {
    expect(files.filter((f) => f.includes("/pages/")).length).toBeGreaterThan(100);
  });

  it("no module-level TENANT_ID / DEMO_TENANT constant and no tenant-00N / demo-tenant literal outside the allowlist", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      if (ALLOWED.has(rel)) continue;
      stripComments(readFileSync(f, "utf8")).split("\n").forEach((line, i) => {
        if (/^\s*(export\s+)?const\s+(TENANT_ID|DEMO_TENANT|DEFAULT_TENANT(_ID)?)\s*=\s*["'`]/.test(line) || /["'`](tenant-00\d|demo-tenant[-\w]*)["'`]/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders, `these send a fixed tenant id instead of the signed-in user's:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("every routed page has the sidebar, unless it is deliberately public", () => {
  // /wholesale and /group-deals are entries in the merchant sidebar and rendered WITHOUT one — clicking them made it vanish.
  const PUBLIC = new Set([
    "/", "/track/:token", "/shop/:slug", "/evidence/:token", "/sla-extension/:token", "/discover", // public / token links
    "/portal/login", "/portal/magic-login", "/portal/sso-callback", // sign-in plumbing
    "/404",
  ]);
  const APPS: Array<[string, string, string]> = [
    ["legacy client", "client/src/App.tsx", "client/src"],
    ["tenant-portal", "ui/tenant-portal/src/App.tsx", "ui/tenant-portal/src"],
    ["platform-admin", "ui/platform-admin/src/App.tsx", "ui/platform-admin/src"],
  ];
  const LAYOUT = /<(DashboardLayout|TenantPortalLayout)\b/;

  function pageFile(spec: string, srcRoot: string): string | null {
    const base = spec.startsWith("@/") ? join(ROOT, "client/src", spec.slice(2)) : join(ROOT, srcRoot, spec);
    for (const ext of [".tsx", "/index.tsx"]) if (existsSync(base + ext)) return base + ext;
    return null;
  }
  const hasLayout = (file: string, depth = 0): boolean => {
    const src = readFileSync(file, "utf8");
    if (LAYOUT.test(src)) return true;
    if (depth >= 2) return false;
    for (const m of src.matchAll(/from "(@\/[^"]+|\.{1,2}\/[^"]+)"/g)) {
      const dep = m[1].startsWith("@/") ? join(ROOT, "client/src", m[1].slice(2)) : join(file, "..", m[1]);
      for (const ext of [".tsx", "/index.tsx"]) if (existsSync(dep + ext) && /pages|components/.test(dep) && hasLayout(dep + ext, depth + 1)) return true;
    }
    return false;
  };

  it.each(APPS)("%s", (_name, appFile, srcRoot) => {
    const app = read(appFile);
    const files: Record<string, string> = {};
    for (const m of app.matchAll(/const (\w+) = lazy\(\(\) => import\("([^"]+)"\)\)/g)) files[m[1]] = m[2];
    for (const m of app.matchAll(/import (\w+) from "([^"]+)"/g)) files[m[1]] = m[2];
    const routes = [...app.matchAll(/<Route path="([^"]+)" component=\{(\w+)\}/g)];
    expect(routes.length, "route table found").toBeGreaterThan(20);
    const bare: string[] = [];
    for (const [, path, comp] of routes) {
      const f = files[comp] && pageFile(files[comp], srcRoot);
      if (f && !hasLayout(f) && !PUBLIC.has(path)) bare.push(`${path} (${comp})`);
    }
    expect(bare, `routed pages with no sidebar layout and not in the public allowlist:\n  ${bare.join("\n  ")}`).toEqual([]);
  });
});

describe("the shell", () => {
  const layout = read("client/src/components/DashboardLayout.tsx");

  it("never navigates to /settings — a route that exists in no app, so it landed on the sidebar-less 404", () => {
    expect(layout).not.toMatch(/setLocation\("\/settings"\)/);
    for (const app of ["client/src/App.tsx", "ui/tenant-portal/src/App.tsx", "ui/platform-admin/src/App.tsx"]) {
      expect(read(app), app).not.toMatch(/<Route path="\/settings"/);
    }
  });

  it("marks exactly the links whose pages only admins can use as adminOnly (Escrow, Revenue), so a merchant is not offered a 403", () => {
    const tenantNav = layout.slice(layout.indexOf("const TENANT_NAV_GROUPS"), layout.indexOf("const GET_STARTED_GROUP"));
    const adminOnly = [...tenantNav.matchAll(/path:\s*"([^"]+)",\s*adminOnly:\s*true/g)].map((m) => m[1]).sort();
    expect(adminOnly).toEqual(["/escrow", "/revenue"]);
  });

  it("the portal layout does not show an identity-provider id as the person's name", () => {
    expect(stripComments(read("client/src/components/TenantPortalLayout.tsx"))).not.toMatch(/user\.openId/);
  });

  it("the 404 page keeps the sidebar for a signed-in user", () => {
    expect(read("client/src/pages/NotFound.tsx")).toMatch(/user \? <DashboardLayout>/);
  });
});
