import { createContext, useContext, useState, ReactNode } from "react";

interface TenantContextType {
  activeTenantId: string;
  setActiveTenantId: (id: string) => void;
}

const TenantContext = createContext<TenantContextType>({
  activeTenantId: "tenant-001",
  setActiveTenantId: () => {},
});

export function TenantProvider({ children }: { children: ReactNode }) {
  const [activeTenantId, setActiveTenantId] = useState("tenant-001");
  return (
    <TenantContext.Provider value={{ activeTenantId, setActiveTenantId }}>
      {children}
    </TenantContext.Provider>
  );
}

export function useActiveTenant() {
  return useContext(TenantContext);
}
