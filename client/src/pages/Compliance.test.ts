/**
 * Route/wiring guards for the SOC2 Compliance dashboard.
 *
 * The repo has no jsdom/testing-library page-render harness (vitest runs in
 * node env; see client/bundleSplit.test.ts for precedent), so these are
 * static source-level guards: they verify the page exists, is lazy-loaded,
 * routed, nav-linked, and calls exactly the fixed tRPC contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const pagePath = path.join(root, "client/src/pages/Compliance.tsx");
const appSrc = readFileSync(path.join(root, "client/src/App.tsx"), "utf8");
const navSrc = readFileSync(path.join(root, "client/src/components/DashboardLayout.tsx"), "utf8");

describe("Compliance (SOC2) page wiring", () => {
  it("page file exists", () => {
    expect(existsSync(pagePath)).toBe(true);
  });

  // QA follow-up: /soc2 is platform-wide security tooling (audit chain,
  // access review, anomaly/collusion detection) that had no guard at all in
  // the legacy app, reachable by any signed-in user via direct URL. Rather
  // than lazy-load Compliance.tsx directly here, the legacy app now
  // redirects to its properly admin-gated home in ui/platform-admin (which
  // still imports and routes to this same Compliance.tsx page directly —
  // see ui/platform-admin/src/App.tsx).
  it("redirects /soc2 to ui/platform-admin instead of rendering it directly", () => {
    expect(appSrc).not.toContain('const Compliance = lazy(() => import("./pages/Compliance"))');
    expect(appSrc).toContain('<Route path="/soc2" component={() => <AdminRouteRedirect to="/soc2" />} />');
  });

  it("has a nav entry", () => {
    expect(navSrc).toContain('path: "/soc2"');
  });

  it("consumes the fixed compliance tRPC contract", () => {
    const src = readFileSync(pagePath, "utf8");
    for (const proc of ["verifyAuditChain", "accessReview", "retentionPolicies", "incidentStatus"]) {
      expect(src, proc).toContain(`.${proc}.useQuery`);
    }
  });

  it("isolates the not-yet-typed compliance router behind a cast seam", () => {
    const src = readFileSync(pagePath, "utf8");
    expect(src).toContain("(trpc as any).compliance");
  });
});
