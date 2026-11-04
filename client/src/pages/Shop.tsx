/**
 * Shop: the public store at /shop/:slug and everything under it (products, cart, checkout, account,
 * orders). The store itself lives in client/src/storefront.
 */
import { useLocation, useRoute } from "wouter";
import { LiveStore, TemplatePreview } from "@/storefront/StoreApp";

export default function Shop() {
  const [location] = useLocation();
  const [, params] = useRoute("/shop/:slug/*?");
  const slug = params?.slug ?? "";
  return <LiveStore slug={slug} path={location.slice(`/shop/${slug}`.length)} />;
}

export function StorePreview() {
  const [location] = useLocation();
  const [, params] = useRoute("/store-preview/:id/*?");
  const id = params?.id ?? "";
  return <TemplatePreview templateId={id} path={location.slice(`/store-preview/${id}`.length)} />;
}
