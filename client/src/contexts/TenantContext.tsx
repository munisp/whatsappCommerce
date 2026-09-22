import { createContext, useContext, useState, ReactNode } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { resolveActiveTenant } from "@/lib/tenantAccess";

interface TenantContextType {
  /** The business every tenant-scoped query must use. "" means "none yet" — callers must not fire queries for it. */
  activeTenantId: string;
  /** Only meaningful for platform admins (the tenant switcher). Everyone else's tenant is their own and cannot be chosen. */
  setActiveTenantId: (id: string) => void;
}

const TENANT_STORAGE_KEY = "active-tenant-id";
/** A platform admin's starting selection (the seeded demo tenant). It is NEVER used for anyone else — see resolveActiveTenant. */
const ADMIN_DEFAULT_TENANT_ID = "tenant-001";

// QA-043: the default with no provider is "no tenant", not the demo tenant. ui/tenant-portal never mounted a provider, so
// this default was what 24 of its pages sent on every query — and the server refused it with a 403 for every real merchant.
const TenantContext = createContext<TenantContextType>({
  activeTenantId: "",
  setActiveTenantId: () => {},
});

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  // A platform admin's own selection, restored across reloads. It is read from storage but never USED for a non-admin:
  // a stale value left behind by a previous account on this browser must not decide what a merchant's pages ask for.
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(TENANT_STORAGE_KEY) || ADMIN_DEFAULT_TENANT_ID;
    } catch {
      return ADMIN_DEFAULT_TENANT_ID;
    }
  });

  const setActiveTenantId = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(TENANT_STORAGE_KEY, id);
    } catch { /* storage unavailable */ }
  };

  // Derived on every render from who is signed in — not set from an effect after the first paint, which is what let pages
  // fire their first queries with the wrong tenant (and get a 403) before the layout corrected it.
  const activeTenantId = resolveActiveTenant(user, selected);

  return (
    <TenantContext.Provider value={{ activeTenantId, setActiveTenantId }}>
      {children}
    </TenantContext.Provider>
  );
}

export function useActiveTenant() {
  return useContext(TenantContext);
}
