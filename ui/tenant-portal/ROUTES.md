# Tenant Portal — route triage

All routes reuse existing page components from `client/src/pages` (via the
`@` alias) — nothing was copied or duplicated. This file records the triage
decisions and known open questions from splitting the original single-app
`client/src/App.tsx` (94 routes) into `ui/platform-admin` and
`ui/tenant-portal`.

## Likely-duplicate pairs — resolved

The app grew two parallel implementations of several merchant features: an
older set that reads the active tenant from `TenantContext`'s client-side
picker (`useActiveTenant()`), and a newer `/portal/*` set built on a
purpose-built, implicitly-scoped `tenantPortal.*` API (no explicit tenantId
needed — always the caller's own tenant). Per-pair resolution below, decided
by actually comparing feature coverage (not just which API is "newer"):

| Legacy route | Portal equivalent | Winner | Why |
|---|---|---|---|
| `/dashboard` (Dashboard) | `/portal` (PortalDashboard) | **Portal** | Dashboard.tsx showed a platform-wide admin stat (`analytics.platformOverview`, adminProcedure) plus two charts hardcoded to static demo arrays — never real for any tenant. `/dashboard` now redirects to `/portal`. |
| `/products` (Products) | `/portal/products` (PortalProducts) | **Legacy** | Legacy has CSV import/validate + stats; portal was view+update only. `/portal/products` now redirects to `/products`. |
| `/orders` (Orders) | `/portal/orders` (PortalOrders) | **Legacy** | Legacy links to `/orders/:orderNumber` (OrderTimeline.tsx) — customer replies, notification status, quick-reply templates — far richer than portal's inline detail view. Redirects to `/orders`. |
| `/invoices` (Invoices) | `/portal/invoices` (PortalInvoices) | **Legacy** | Legacy can generate/send/mark-paid; portal was list-only. Redirects to `/invoices`. |
| `/conversations` (Conversations) | `/portal/conversations` (PortalConversations) | **Legacy** | Legacy has delivery-receipt tracking/metrics; portal was list-only. Redirects to `/conversations`. |
| `/payments` (Payments) | `/portal/payments` (PortalPayments) | **Legacy** | Comparable scope; kept for consistency with the rest of this table. Redirects to `/payments`. |
| `/broadcast` (BroadcastCampaigns) | `/portal/broadcasts` (PortalBroadcasts) | **Legacy** | Legacy has full CRUD, A/B testing, delivery simulation; portal covered create/list/send only. Redirects to `/broadcast`. |
| `/tenant-settings` (TenantSettings) | `/portal/settings` (PortalSettings) | **Legacy** | TenantSettings is ~1450 lines (branding incl. logo upload, custom domains, commerce zones, inventory source, CRM pipeline, CTWA links) vs PortalSettings' ~110 (store name/currency + a payment-gateway form that `/provider-settings` already covers more thoroughly). Redirects to `/tenant-settings`. |
| `/tenant-analytics` (TenantAnalytics) | `/portal/analytics` (MerchantAnalytics) | **Portal** | TenantAnalytics.tsx has a platform-wide "pick any tenant" selector powered by `tenant.list` (adminProcedure) — it's a platform-admin tool that was misplaced in tenant-portal, not a tenant's own analytics. **Moved to `ui/platform-admin`**; `/tenant-analytics` here now redirects to `/portal/analytics`, the real one. |

The retired legacy `/portal/*` page files (PortalProducts.tsx, PortalOrders.tsx,
etc.) and `TenantPortalLayout.tsx` itself were NOT deleted — they're still
routed by the separate legacy `client/src/App.tsx` monolith. They're just no
longer reachable from `ui/tenant-portal`'s own routing.

## Genuinely ambiguous placements (best guess, flag if wrong)

- `/logistics`, `/logistics-map` — logistics tracking could be tenant-owned
  fulfilment (kept here) or platform-wide ops oversight (would move to
  platform-admin).
- `/analytics-bi` — could be a tenant's own BI view or a platform-wide
  aggregate; kept here because it wasn't gated `adminOnly` in the legacy nav.
- `/hermes`, `/scan-stats`, `/label-studio`, `/fmcg-taxonomy` — placed in
  platform-admin as internal ML/data tooling; if any of these are actually
  tenant-facing (e.g. a merchant's own product taxonomy), they belong here
  instead.

## Public, token-gated routes

`/track/:token`, `/evidence/:token`, `/sla-extension/:token` render without
the AuthGate — access control is the token itself (validated server-side),
not a WhatsApp Commerce session. These are reached by customers/suppliers
who may have no account at all.
