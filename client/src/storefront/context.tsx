import { createContext, useContext, type ReactNode } from "react";
import type { StoreConfig } from "@shared/storefront/config";
import type { useCart } from "./cart";

export interface StoreProduct {
  id: string; name: string; description: string | null; category: string | null; price: string; currency?: string;
  compareAtPrice: string | null; imageUrl: string | null; images: string[]; inStock: boolean; lowStock: boolean;
  sold: number; isNew: boolean; featured: boolean; preorder?: boolean; ageRestricted?: boolean; minAge?: number | null;
  options: { name: string; values: string[] }[];
  variants?: { id: string; label: string; attributes: Record<string, string>; inStock: boolean }[];
}

export interface StoreData {
  slug: string; name: string; currency: string; config: StoreConfig; whatsapp: string | null; whatsappShopRef?: string | null; isDraft?: boolean; isLive?: boolean;
  categories: { name: string; imageUrl: string | null; count: number }[];
  catalog: StoreProduct[];
  promos: { code: string | null; title: string; discountText: string }[];
  reviews: { rating: number; text: string; productId?: string; author?: string }[];
  checkout: { pickup: boolean; cod: boolean; online: boolean };
}

export interface StoreContextValue {
  store: StoreData;
  /** A sample store for template previews: browsing works, nothing can be bought. */
  demo: boolean;
  base: string;
  /** Turns a store-relative link into a real URL. */
  href: (path: string) => string;
  go: (path: string) => void;
  cart: ReturnType<typeof useCart>;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}

const Ctx = createContext<StoreContextValue | null>(null);
export const StoreProvider = ({ value, children }: { value: StoreContextValue; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useStore(): StoreContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useStore must be used inside a store");
  return value;
}
