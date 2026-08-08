import { createContext, useContext, useState, ReactNode } from "react";

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

  const setActiveTenantId = (id: string) => {
    setActiveTenantIdState(id);
    try {
      localStorage.setItem(TENANT_STORAGE_KEY, id);
    } catch { /* storage unavailable */ }
  };

  return (
    <TenantContext.Provider value={{ activeTenantId, setActiveTenantId }}>
      {children}
    </TenantContext.Provider>
  );
}

export function useActiveTenant() {
  return useContext(TenantContext);
}
