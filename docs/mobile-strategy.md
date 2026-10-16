# Mobile Strategy — W55 decision record (MOB-1, MOB-2, MOB-5 queue note)

Status: accepted decisions for the w55 cycle. Audit: `w55/audit-c-pwa-mobile.md`.

## MOB-1 — Native app decision record: PWA-first

**Decision: no native mobile app. The PWA is the entire mobile story, by design.**

Rationale:

- The platform's buyer surface is deliberately conversational — orders,
  events tickets (W53) and memberships (W54) live in WhatsApp chat and USSD
  (`server/routers/membershipPlans.ts:8-11`, `server/routers/events.ts`
  header), not in any installed app. A native app would not replace those
  channels; it would only duplicate the merchant/admin web surfaces.
- The three web surfaces (client/ legacy app, ui/tenant-portal,
  ui/platform-admin) are all installable PWAs as of W55 (MOB-4), with offline
  shells and read-through API caching (MOB-5). That covers the merchant
  on-the-go use cases (orders, wallet, conversations, evidence review).
- Cost: one React/TS codebase already serves 220+ routes across three apps;
  a RN/Expo/Capacitor fork would double every frontend change and require new
  CI, signing, store-review, and OTA-update infrastructure the team does not
  have.
- Nigerian market reality: low-end Android devices dominate; an installable
  PWA (a few hundred KB shell + cached assets) beats a 30–80MB store binary
  for data-cost and storage-constrained users, and WhatsApp is already the
  installed app buyers live in.

**Triggers that would reopen the native decision:**

1. Web push (MOB-2) proves insufficient for re-engagement metrics (push is the
   main capability gap; iOS PWA push requires 16.4+ and an installed PWA).
2. App-store presence becomes a commercial requirement (merchant acquisition
   channel, competitor parity).
3. A feature needs hardware APIs the web lacks (e.g. background geolocation,
   Bluetooth POS printers, offline-first local DB beyond IndexedDB quotas).
4. Installed-PWA retention measurably lags native benchmarks after the MOB-2
   push channel lands.

If triggered, prefer Capacitor (reuses the existing React builds) over a
greenfield RN rewrite.

## MOB-2 — Web push design (REQUIRES DEPENDENCY APPROVAL — not implemented)

**Status: design only.** Sending Web Push from Node requires the `web-push`
package (VAPID signing, payload encryption per RFC 8291/8292). Lockfiles are
frozen for W55, so this is **not implemented**; do not hand-roll ECDH/AES-GCM
push crypto.

### Proposed design

1. **VAPID**: generate a keypair once (`npx web-push generate-vapid-keys`);
   public key exposed to clients via `GET /api/trpc/push.vapidPublicKey`
   (or baked env), private key in server env (`WEB_PUSH_PRIVATE_KEY`).
2. **Subscription table** (`push_subscriptions`): id (uuid), user_id (FK),
   tenant_id (nullable — platform-admin users span tenants), endpoint (text,
   unique), p256dh, auth, user_agent, created_at, last_seen_at, revoked_at.
   Upsert on (endpoint); delete on 404/410 send responses (expired).
3. **Client**: after SW registration, `PushManager.subscribe({ userVisibleOnly:
   true, applicationServerKey })` behind an explicit opt-in UI (never on page
   load — permission prompts on load are auto-denied by Chrome). SW gains a
   `push` listener showing `registration.showNotification` and a
   `notificationclick` handler deep-linking into the relevant route.
4. **Send service** (`server/services/webPush.ts`): fan-out on existing
   notification events (order status change, dispute ping, escrow release,
   ticket delivery) after the Go notification-service channel dispatch —
   web push is an additional channel, not a replacement for WA/SMS. Payload
   stays small (title, body, url, tag); no PII beyond what the push service
   already transports.
5. **Dependency to approve**: `web-push` (+ `@types/web-push` dev). No other
   new deps.

## MOB-5 note — offline write queue / background sync: out of scope

W55 adds NetworkFirst caching for read-only `GET /api/trpc/*` queries only.
An offline **write** queue (order capture, evidence upload, broadcast send)
requires Background Sync / IndexedDB outbox machinery; workbox-background-sync
is part of the already-shipped workbox runtime, but safe mutation replay needs
idempotency keys on money-adjacent endpoints — a server-side change that is
explicitly out of scope for W55 (money paths frozen). Mutations therefore fail
loudly offline (the `/api/` navigateFallback denylist is unchanged). Revisit
with an idempotency-key design before enabling.
