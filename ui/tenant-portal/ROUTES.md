# Tenant Portal — route triage

All routes reuse existing page components from `client/src/pages` (via the
`@` alias) — nothing was copied or duplicated. This file records the triage
decisions and known open questions from splitting the original single-app
`client/src/App.tsx` (94 routes) into `ui/platform-admin` and
`ui/tenant-portal`.

## Likely-duplicate pairs (not resolved — both kept reachable)

The app grew two parallel implementations of several merchant features: an
older set that reads the active tenant from `TenantContext`'s client-side
picker (`useActiveTenant()`, no backend enforcement), and a newer `/portal/*`
set that is properly scoped server-side via `tenantPortalRouter`'s
`ctx.user.tenantId`. Both are included here unmodified; picking a canonical
one and retiring the other is a follow-up decision, not made in this pass.

| Legacy route | Portal equivalent |
|---|---|
| `/dashboard` (Dashboard) | `/portal` (PortalDashboard) |
| `/products` (Products) | `/portal/products` (PortalProducts) |
| `/orders` (Orders) | `/portal/orders` (PortalOrders) |
| `/invoices` (Invoices) | `/portal/invoices` (PortalInvoices) |
| `/conversations` (Conversations) | `/portal/conversations` (PortalConversations) |
| `/payments` (Payments) | `/portal/payments` (PortalPayments) |
| `/broadcast` (BroadcastCampaigns) | `/portal/broadcasts` (PortalBroadcasts) |
| `/tenant-settings` (TenantSettings) | `/portal/settings` (PortalSettings) |
| `/tenant-analytics` (TenantAnalytics) | `/portal/analytics` (MerchantAnalytics) |

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
