# Medusa v2 Commerce Integration Guide

This platform includes a **Medusa v2 API adapter** that routes all product, order, cart, inventory, and pricing operations through a Medusa instance when configured. When not configured, the platform falls back to its own native tables seamlessly.

---

## Quick Start

### Option A — Self-Hosted Medusa (Recommended for full control)

```bash
# On a separate server or VM (not inside this sandbox):
npx create-medusa-app@latest my-commerce --db-url "postgresql://..." --no-browser
cd my-commerce
npx medusa develop
```

Medusa runs on port **9000** by default. The admin dashboard is at `http://your-server:9000/app`.

### Option B — Medusa Cloud

1. Sign up at [cloud.medusajs.com](https://cloud.medusajs.com)
2. Create a new project
3. Copy the **Storefront API URL** and **Admin API Key** from the project settings

---

## Connecting to This Platform

Add these two secrets via **Settings → Secrets** in the Manus Management UI:

| Secret Key | Value | Description |
|---|---|---|
| `MEDUSA_API_URL` | `https://your-medusa-server.com` | Base URL of your Medusa instance (no trailing slash) |
| `MEDUSA_API_KEY` | `your-admin-api-key` | Admin API key from Medusa dashboard |

Once set, navigate to **Medusa Commerce** in the sidebar — the status badge will turn green and all products, orders, and regions will sync from Medusa.

---

## What the Adapter Provides

| Feature | Medusa Endpoint | Platform tRPC Procedure |
|---|---|---|
| Product catalog | `GET /store/products` | `trpc.medusa.listProducts` |
| Single product | `GET /store/products/:id` | `trpc.medusa.getProduct` |
| Collections | `GET /store/collections` | `trpc.medusa.listCollections` |
| Categories | `GET /store/product-categories` | `trpc.medusa.listCategories` |
| Regions / currencies | `GET /store/regions` | `trpc.medusa.listRegions` |
| Cart create | `POST /store/carts` | `trpc.medusa.createCart` |
| Add to cart | `POST /store/carts/:id/line-items` | `trpc.medusa.addToCart` |
| Get cart | `GET /store/carts/:id` | `trpc.medusa.getCart` |
| Order list (admin) | `GET /admin/orders` | `trpc.medusa.listOrders` |
| Order detail (admin) | `GET /admin/orders/:id` | `trpc.medusa.getOrder` |
| Price lists (admin) | `GET /admin/price-lists` | `trpc.medusa.listPriceLists` |
| Create price list | `POST /admin/price-lists` | `trpc.medusa.createPriceList` |
| Promotions (admin) | `GET /admin/promotions` | `trpc.medusa.listPromotions` |

---

## WhatsApp ↔ Medusa Flow

When a buyer sends a product inquiry via WhatsApp:

1. NLP engine detects `product_inquiry` intent
2. Platform calls `medusa.listProducts({ q: productName })` via the adapter
3. Product details (variants, prices, inventory) are formatted into a WhatsApp reply
4. When buyer confirms order, `medusa.createCart` + `addToCart` creates the cart in Medusa
5. Payment is handled by the platform's existing Paystack/escrow layer
6. On payment confirmation, the order is fulfilled in Medusa via the admin API

---

## Fallback Behaviour

If `MEDUSA_API_URL` is not set:
- `listProducts` returns `{ products: [], count: 0 }`
- `listOrders` returns `{ orders: [], count: 0 }`
- All cart operations return empty/mock responses
- The platform continues to operate using its own `products`, `orders`, and `inventory` tables

This means you can deploy the platform and connect Medusa later with zero downtime.

---

## Recommended Medusa Plugins

| Plugin | Purpose |
|---|---|
| `@medusajs/fulfillment-manual` | Manual fulfillment for offline merchants |
| `@medusajs/payment-stripe` | Stripe payment provider |
| `@medusajs/inventory` | Multi-location inventory |
| `@medusajs/file-local` | Local file storage (dev only) |
| `@medusajs/file-s3` | S3 file storage (production) |

---

## Support

- Medusa docs: [docs.medusajs.com](https://docs.medusajs.com)
- Medusa Discord: [discord.gg/medusajs](https://discord.gg/medusajs)
- Platform issues: open a GitHub issue on this repository
