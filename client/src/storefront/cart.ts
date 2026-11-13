import { useCallback, useEffect, useState } from "react";

export interface CartLine { productId: string; variantId: string | null; quantity: number }

const keyFor = (slug: string) => `store-cart:${slug}`;

function read(slug: string): CartLine[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(slug)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l?.productId === "string" && l.quantity > 0) : [];
  } catch {
    return [];
  }
}

/** Kept per store in this browser, so a cart survives a reload and never crosses to another shop. */
export function useCart(slug: string, persist: boolean) {
  const [lines, setLines] = useState<CartLine[]>(() => (persist ? read(slug) : []));
  useEffect(() => {
    if (!persist) return;
    try { localStorage.setItem(keyFor(slug), JSON.stringify(lines)); } catch { /* private mode: the cart lasts this visit */ }
  }, [lines, slug, persist]);

  const add = useCallback((productId: string, variantId: string | null, quantity = 1) => {
    setLines((current) => {
      const hit = current.find((l) => l.productId === productId && l.variantId === variantId);
      return hit
        ? current.map((l) => (l === hit ? { ...l, quantity: l.quantity + quantity } : l))
        : [...current, { productId, variantId, quantity }];
    });
  }, []);
  const setQuantity = useCallback((productId: string, variantId: string | null, quantity: number) => {
    setLines((current) => (quantity <= 0
      ? current.filter((l) => !(l.productId === productId && l.variantId === variantId))
      : current.map((l) => (l.productId === productId && l.variantId === variantId ? { ...l, quantity } : l))));
  }, []);
  const clear = useCallback(() => setLines([]), []);
  return { lines, add, setQuantity, clear, count: lines.reduce((n, l) => n + l.quantity, 0) };
}
