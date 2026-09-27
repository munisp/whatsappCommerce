import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";

interface TenantContextType {
  activeTenantId: string;
  setActiveTenantId: (id: string) => void;
}

const TENANT_STORAGE_KEY = "active-tenant-id";
const DEFAULT_TENANT_ID = "tenant-001";

const TenantContext = createContext<TenantContextType>({
  activeTenantId: DEFAULT_TENANT_ID,
  setActiveTenantId: () => {},
});

export function TenantProvider({ children }: { children: ReactNode }) {
  // Restore the last selected tenant so the switcher survives reloads.
  const [activeTenantId, setActiveTenantIdState] = useState(() => {
    try {
      return localStorage.getItem(TENANT_STORAGE_KEY) || DEFAULT_TENANT_ID;
    } catch {
      return DEFAULT_TENANT_ID;
    }
  });

  const setActiveTenantId = useCallback((id: string) => {
    setActiveTenantIdState(id);
    try {
      localStorage.setItem(TENANT_STORAGE_KEY, id);
    } catch { /* storage unavailable */ }
  }, []);

  // === W48 perf (PERF-FE-11): memoized context value — consumers only
  // re-render when the tenant actually changes, not on provider re-renders.
  const value = useMemo<TenantContextType>(
    () => ({ activeTenantId, setActiveTenantId }),
    [activeTenantId, setActiveTenantId]
  );

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
}

export function useActiveTenant() {
  return useContext(TenantContext);
}
