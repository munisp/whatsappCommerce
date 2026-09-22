/**
 * QA-043: the rules that decide WHICH BUSINESS a signed-in person is looking at, and what the shell shows them.
 *
 * Why these live in one small pure module: the shell (sidebar, tenant context, onboarding gate) is shared by three apps
 * (the legacy client, ui/tenant-portal, ui/platform-admin), and the bugs it had were all the same mistake made in
 * different places — the client picking a tenant id for the user instead of asking who the user IS:
 *   - `TenantContext` defaulted to the demo tenant "tenant-001", and ui/tenant-portal never even mounted the provider, so
 *     24 of its pages sent "tenant-001" on every query. The server (correctly) answered 403 "You can only access your
 *     own tenant's data" for every real merchant;
 *   - eleven pages hard-coded "default" / "demo-tenant-1" / "tenant-001" outright;
 *   - a freshly REGISTERED user has no tenant at all (users.tenantId is null until onboarding.start creates one), and got a
 *     sidebar of tenant pages that all returned 403.
 * Nothing here touches React, the network or storage, so each rule can be pinned by a test that cannot be fooled by rendering.
 */

/** The parts of the signed-in user (`auth.me`) these rules need. */
export type SessionUser =
  | { id?: number | string; role?: string | null; tenantId?: string | null; name?: string | null; email?: string | null }
  | null
  | undefined;

/**
 * The only page a signed-in user with no business yet may open: the wizard that CREATES one (it calls onboarding.start).
 * Everything else — including the older /onboarding KYB page and /portal/setup — needs an existing business, so for a user
 * without one it can only fail (403); they get the set-up screen with a button to the wizard instead.
 */
export const NO_BUSINESS_ALLOWED_PATHS = ["/onboarding-wizard"] as const;

/** Platform admins are tenant-agnostic by design: they pick a tenant with the switcher and may have none of their own. */
export const isPlatformAdmin = (u: SessionUser): boolean => u?.role === "admin";

/** A signed-in, non-admin user who has not created (or been given) a business yet — i.e. anyone who has just registered. */
export function needsBusinessSetup(u: SessionUser): boolean {
  return !!u && !isPlatformAdmin(u) && !u.tenantId;
}

/** Exact match or a sub-path, so "/onboarding" allows "/onboarding/step-2" but not "/onboarding-evil" or "/onboardingx". */
export function isAllowedWithoutBusiness(path: string): boolean {
  const p = (path.split("?")[0].split("#")[0] || "/").replace(/\/+$/, "") || "/";
  return NO_BUSINESS_ALLOWED_PATHS.some((a) => p === a || p.startsWith(a + "/"));
}

/**
 * The tenant id every tenant-scoped query must carry. NEVER a default: the wrong tenant is a 403 at best and someone
 * else's data at worst.
 *  - signed out → "" (nothing may be asked yet)
 *  - platform admin → whatever they picked in the switcher
 *  - anyone else → their own tenant, or "" if they have none (the shell then shows the set-up screen instead of the page)
 */
export function resolveActiveTenant(u: SessionUser, selectedByAdmin: string): string {
  if (!u) return "";
  if (isPlatformAdmin(u)) return selectedByAdmin;
  return u.tenantId ?? "";
}

const clean = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");

/** What to call the person: their name, else the part of their email before the @, else a neutral word — never "User". */
export function displayNameFor(u: SessionUser): string {
  const name = clean(u?.name);
  if (name) return name;
  const email = clean(u?.email);
  if (email) return email.split("@")[0] || email;
  return "Account";
}

export function initialFor(u: SessionUser): string {
  return displayNameFor(u).charAt(0).toUpperCase() || "A";
}

/**
 * The third line of the sidebar's account block. Business name when there is one, else who they are: this is what tells a
 * newly registered person "you are signed in, and you have not set a business up yet" instead of leaving them guessing.
 */
export function accountSubtitle(u: SessionUser, businessName: string | null | undefined): string {
  if (!u) return "";
  if (isPlatformAdmin(u)) return "Platform admin";
  if (!u.tenantId) return "No business yet";
  return clean(businessName) || "Merchant";
}
