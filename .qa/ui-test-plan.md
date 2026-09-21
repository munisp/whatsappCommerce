# UI test plan — round 1 (2026-09-21)

**Purpose.** Everything in this plan is something I could **not** prove from a terminal: a real browser, a real Keycloak login, what a person actually sees. I have already verified everything a terminal can prove (table below), so nothing here is busywork.

**How long.** ~90 minutes for everything; **Group A alone (~25 min) is the one that matters most** — it is the only part of today's work I could not test end to end.

---

## 0. Read this first

### 0.1 What I already verified (you do not need to repeat these)

| Check | Result |
|---|---|
| `GET /api/auth/callback?code=x&state=y` with no cookie | **400** (login CSRF guard) |
| `/api/auth/login?redirect=https://evil.example` | redirects to Keycloak with PKCE `S256` and `state`; Keycloak **accepts** the request (HTTP 200 login form, no `redirect_uri` error) |
| `GET /api/finetune/export-yolo`, logged out | **401** |
| `GET /api/finetune/stream`, logged out | **403** |
| `GET /`, `/platform-admin/`, `/tenant-portal/` | **200**, each ships a JS bundle |
| `GET /api/auth/me`, logged out | `{"user":null}` |
| Admin tRPC query with no session | `FORBIDDEN` (10002) |
| App `/health/ready` | ok; db, redis, keycloak, tigerbeetle, odoo outbox, kafka all `true` |
| Running bundle contains the new login guard, the header-sending code and the ledger/webhook fixes | confirmed **in the running pod**, not just the image |
| Bridge / recon-worker / commerce-engine refuse a request with no key, accept the right key | confirmed from inside the cluster |

### 0.2 Environment

| | |
|---|---|
| Merchant / legacy SPA | `https://wa-app.newfire.app/` |
| Tenant portal | `https://wa-app.newfire.app/tenant-portal/` |
| Platform admin | `https://wa-app.newfire.app/platform-admin/` |
| Login | Keycloak, realm `wacommerce` (`keycloak-servers.newfire.app`) |
| Build under test | `server:qa-local8` (2 replicas, HPA 2–4); `ledger-bridge`, `recon-worker`: `qa-local4`; `commerce-engine`: `qa-local2` |

### 0.3 Accounts — and the one precondition you must check first

**`OWNER_OPEN_ID` is not set on the live server, so nobody becomes admin at login.** An account is admin only if its `users.role` was set to `admin` in the database at some point. So before anything else, do **S0**.

- **S0 — find out what role your account has.** Sign in (any way), then open a new tab to `https://wa-app.newfire.app/api/auth/me`. You will see JSON like `{"user":{"id":…,"role":"admin"|"user","tenantId":"…"|null,…}}`. Write down `role` and `tenantId`.
- **How to get a login — there are no credentials in this repo or in this plan, on purpose, and I was never given any.** Sign-in page: `https://wa-app.newfire.app/api/auth/login?redirect=%2F` (or open `/tenant-portal/` or `/platform-admin/` and click **Sign In**). It is Keycloak, realm **`wacommerce`** at `keycloak-servers.newfire.app`, titled "Sign in to wacommerce". Ways in, best first:
  1. **Register yourself.** The sign-in form has a **Register** link (self-registration looks enabled; I did not try it, because it adds a user to a shared identity provider — your call). Use an email you control. A brand-new account is `role: "user"`.
  2. **Use an account you already have** in that realm, if someone created one for you.
  3. **Ask whoever administers that Keycloak** to create one.
  Do **not** try `admin`/`admin` from `services/keycloak/README.md`: that is the *local dev container's* admin console, not this system, and guessing passwords against a shared identity provider is the wrong move. The repo's own realm export (`services/keycloak/config/realm-export.json`, a different realm name) defines zero users.
  **Once you can sign in:** open `/api/auth/me`, then send me the email and say "make it admin" — I will set that one row's role in the app database (a live-DB write, so only on your explicit word). Group C3 additionally needs a second account in a different tenant.
- **You need:** (1) **any** account → Group A; (2) an account with `"role":"admin"` → Groups B, D, parts of C/G; (3) *ideally* a second, non-admin account that belongs to a tenant → Group C; (4) *optionally* a third account in a **different** tenant → C3.
- **If you have no admin account:** tell me which email to promote and I'll do a one-row `UPDATE` on the app database — but that is a write to the live database, so I'll only do it on your explicit say-so.

### 0.4 Browser setup (please do this once)

1. **Chrome.** Use a **normal window** for logged-in tests and a **Private/Incognito window** for logged-out ones.
2. Open DevTools (**⌥⌘I**) **before** loading any page. **Network** tab → tick **Preserve log** and **Disable cache**. **Console** tab open in a split.
3. Keep the clock visible — for any failure, note the **time to the second** (I match it against server logs).

### 0.5 How to report back (paste this per test)

```
A1  PASS
A2  FAIL  20:14:32  landed on / instead of /platform-admin/   [screenshot] [Network: GET /api/auth/callback → 302 Location: /]
B3  BLOCKED  no admin account
```
For every **FAIL** include: the time, a screenshot, and from the Network tab the **URL, status and response body** of the request that went wrong. Say **"starting Group X"** in chat first and I'll tail the server / bridge / recon-worker logs so I can line them up with what you see.

### 0.6 Known and expected — do **not** report these as bugs

- **B4** — there is **no "Provision Float Account" button any more** (removed on purpose, QA-039: it never worked, and making it work would have created permanent, unusable accounts in the shared ledger). B4 now checks that it is gone.
- Several **Infrastructure** tiles are red (Mojaloop, APISIX, OpenAppSec, Permify, OpenSearch, Fluvio, ML stack…): those systems are not deployed here.
- **`commerce-engine`** is not wired into anything that works (gateway's catalog/cart/order routes point at nothing). If a page depends on it, it was already empty.
- Starting a login in **two tabs of the same browser**: the tab whose login was started *earlier* shows "Sign-in expired" if you finish the other one first (the second login replaced the first one's cookie). That is the designed behaviour — one login transaction per browser at a time — see A9.
- **(Unverified — from reading the code, not from running it.)** On the tenant-portal sign-in screen, the small "or sign in with SSO" box: typing a Tenant ID and clicking its button should show **"SSO error: HTTP 401"**, because the call it makes needs a login and the box only appears to signed-out visitors. If it does something else, that is worth a note. (QA-039 item 1 fixed the callback's login-CSRF hole, but this flow can't be started from that screen.)
- The **payment flow itself** (customer pays → webhook → ledger commit) cannot be started from this web UI; it begins in WhatsApp plus a payment-provider webhook. It is covered by the real-TigerBeetle end-to-end test instead.

---

## 1. Index

| ID | What | Needs | ~min | Fix under test |
|---|---|---|---|---|
| **A1** | Sign in from the tenant portal, land back there | any account | 3 | QA-020 |
| **A2** | Sign in from platform-admin, land back there | any account | 3 | QA-020 |
| **A3** | Sign in from a deep link, land on *that* page | any account | 3 | QA-020 |
| **A4** | A crafted callback link is refused, and recovery works | none | 3 | QA-020 |
| **A5** | The post-login redirect can't leave the site | any account | 4 | QA-020 |
| **A6** | Expired session → exactly **one** trip to Keycloak | any account | 5 | QA-020 |
| **A7** | Session stays consistent across 2 replicas | any account | 4 | QA-027 |
| **A8** | Sign out, then sign in again | any account | 3 | QA-020 |
| **A9** | Two tabs starting login at once | any account | 4 | QA-020 |
| **A10** | *(slow, optional)* Idle >10 min at Keycloak | any account | 12 | QA-020 |
| **B1** | Infrastructure tab shows the ledger + recon worker healthy | admin | 3 | QA-038 / 030 |
| **B2** | **Run Reconciliation** works end to end | admin | 4 | QA-038 |
| **B3** | Service Health page | admin | 2 | QA-038 |
| **B4** | The TigerBeetle accounts card has **no** Provision button, and says why | admin | 2 | QA-039 |
| **C1** | Non-admin is refused the admin portal | non-admin | 2 | QA-028 |
| **C2** | Non-admin sees no platform-wide data | non-admin + admin | 6 | QA-017 / 028 |
| **C3** | Another tenant's order is not readable | two tenants | 5 | QA-028 |
| **D1** | Lose a server replica while you click | any + me | 5 | QA-027 |
| **D2** | Ledger bridge down while you click | any + me | 6 | QA-030 |
| **D3** | Rolling restart while you click | any + me | 6 | QA-012 / 027 |
| **E1** | SSRF guard on the Keycloak setup form | admin | 4 | QA-016 |
| **G1** | Smoke sweep of ~16 pages | admin (+ non-admin) | 20 | regression |

**Suggested order:** S0 → A1–A9 → B1–B3 → G1 → C → E1 → D (D last, because I disturb the cluster).

---

## 2. Group A — Login and session (QA-020, QA-027)

**Why this is first.** The login callback used to complete a login even when *this browser had never started one* — anyone who finished a login at Keycloak could hand a victim a crafted link and sign the victim in as the attacker. The callback now demands a signed cookie set at the start of the login. I proved every part of that except the one thing that needs a person: typing real credentials into Keycloak in a real browser and landing back where you started.

**Mechanics you need for the steps.** Clicking *Sign In* navigates to `/api/auth/login?redirect=<where you were>`, which sets a cookie named **`wa_oauth_tx`** (you will see it in DevTools → Application → Cookies for a second) and redirects to Keycloak; Keycloak sends you to `/api/auth/callback`, which clears that cookie, sets the session cookie **`wa_session`** and redirects you to where you started.

### A1 — Sign in from the tenant portal `[P0]`
- **ROLE:** any Keycloak user · **ENVIRONMENT:** normal window, DevTools open · **START STATE:** signed out (Application → Cookies: no `wa_session`)
1. Open `https://wa-app.newfire.app/tenant-portal/`. → *Landing page with a **Sign In** button.*
2. Click **Sign In**. → *Browser goes to Keycloak's login form. Network shows `GET /api/auth/login?redirect=%2Ftenant-portal%2F` → 302 → `keycloak-servers.newfire.app/...`*
3. Enter your credentials. → *You come back to `https://wa-app.newfire.app/tenant-portal/…` (the portal, **not** `/` and **not** an error page).*
4. Open `https://wa-app.newfire.app/api/auth/me` in a new tab. → *`user` is not null; note `role`.*
- **WATCH FOR:** a JSON error page; landing on `/` instead of the portal; a second Keycloak prompt; the words "Sign-in expired".
- **EVIDENCE:** Network entries for `auth/login` and `auth/callback` (status + `Location`).
- **PASS:** back in the portal, signed in. **FAIL:** anything else.

### A2 — Sign in from platform-admin `[P0]`
1. Sign out (or use a Private window). Open `https://wa-app.newfire.app/platform-admin/`. → *A card: "Sign in to continue" with a **Sign In** button.*
2. Click **Sign In**, authenticate. → *You return to `/platform-admin/` (the admin app or, if you are not an admin, its "Access Restricted" page — either is a pass; what matters is the URL).*
- **PASS:** landed on `/platform-admin/`. **FAIL:** landed on `/` or `/tenant-portal/`.

### A3 — Sign in from a deep link `[P0]`
1. Signed out. Open `https://wa-app.newfire.app/orders`. → *"Sign in to continue" with a **Sign in** button (or an automatic redirect to Keycloak).*
2. Sign in. → *You end on `https://wa-app.newfire.app/orders`.*
- **PASS:** exactly `/orders`. **FAIL:** `/` or any other page.

### A4 — A crafted callback link is refused, and you can recover `[P0]`
This is the attack the fix exists to stop, so it is the most important negative test.
- **ENVIRONMENT:** **Private window**, signed out.
1. Paste and open: `https://wa-app.newfire.app/api/auth/callback?code=abc&state=xyz`
   → *A plain page, tab title **"Sign-in expired"**, text "Your sign-in session expired, or it was not started from this browser.", and a link **Sign in again**. Network: status **400**. **You are not signed in** (`/api/auth/me` → `{"user":null}`).*
2. Click **Sign in again**. → *Goes to Keycloak; sign in; you land on `/`.*
- **WATCH FOR:** being signed in after step 1; a raw JSON error instead of the page (only acceptable if it says `login_session_invalid`); a 500.
- **PASS:** 400 page shown, not signed in, recovery works. **FAIL:** signed in, or a 5xx.

### A5 — The post-login redirect cannot leave the site `[P0]`
Before the fix, `/api/auth/login?redirect=<anything>` sent you there after login — a phishing link that looks like our domain.
- **ENVIRONMENT:** Private window, signed out. Run each URL, complete the login each time.
1. `https://wa-app.newfire.app/api/auth/login?redirect=https://example.com` → *after login you are on `https://wa-app.newfire.app/` — **never** `example.com`.*
2. `https://wa-app.newfire.app/api/auth/login?redirect=//example.com` → *same.*
3. `https://wa-app.newfire.app/api/auth/login?redirect=/tenant-portal/` → *you are on `/tenant-portal/` (the safe case must still work).*
- **PASS:** 1 and 2 stay on our domain at `/`; 3 lands in the portal. **FAIL:** you ever end on `example.com`.

### A6 — An expired session causes exactly **one** trip to Keycloak `[P0]`
The SPA fires "log in" once per failed request, and a page with several widgets fails several requests at once. Each used to set a *new* login cookie and they raced, leaving a cookie for a different login than the browser followed. I added a 3-second debounce. This is the test for it.
- **ENVIRONMENT:** signed in. DevTools → Network → **Preserve log**; type `auth/login` in the filter box.
1. Open a widget-heavy page, e.g. `https://wa-app.newfire.app/dashboard`. → *Loads normally.*
2. DevTools → **Application → Cookies → wa-app.newfire.app** → delete **`wa_session`**.
3. Reload the page (or click to another page). → *You are sent to Keycloak.*
4. Count rows in the Network filter for `auth/login`. → ***Exactly 1.***
5. Sign in. → *You return to `/dashboard`, signed in, **no** "Sign-in expired" page.*
6. **Repeat steps 2–5 five times.**
- **WATCH FOR:** 2+ `auth/login` requests within a couple of seconds; landing on "Sign-in expired" after a *correct* login (that would be the race).
- **PASS:** 5/5 runs, one request each, all land back on `/dashboard`. **FAIL:** any run with 2+ requests or an expired page.

### A7 — The session behaves the same on both replicas `[P1]`
There are 2 `server` replicas; sessions are signed tokens, so any replica should accept them.
1. Signed in, click through ~10 different pages over about 3 minutes (mix of list pages and detail pages).
2. Hard-reload (**⇧⌘R**) five times along the way.
- **WATCH FOR:** being logged out at random; a page that works, then the next identical request gets 401 (that pattern means one replica rejects a session the other accepted).
- **PASS:** never asked to sign in, no unexplained 401s. **FAIL:** any of those.

### A8 — Sign out, then sign in again `[P1]`
Logout still uses the Keycloak address baked into the bundle at build time, so it is worth confirming after the rebuild.
1. In the tenant portal click **Sign out** at the bottom of the left sidebar — or, in the main dashboard, open the user menu → **Sign out**. → *You end up on the landing page, signed out; `wa_session` is gone.*
2. Click **Sign In** again. → ***Keycloak asks for credentials** (it must not silently sign you back in), and afterwards you are signed in.*
- **PASS:** credentials requested again, sign-in works. **FAIL:** silently signed in with no prompt, or a Keycloak error page.

### A9 — Two logins in two tabs `[P2 · expected-behaviour check]`
There is one login-transaction cookie per browser, so the **last login started wins**.
1. Signed out. **Tab 1:** click **Sign In**, stop on the Keycloak form. **Tab 2:** open the same site, click **Sign In**, **complete** the login.
2. Back in **Tab 1**, now complete *its* login. → *Tab 1 shows the **"Sign-in expired"** page with **Sign in again**.* Click it. → *You are signed in.*
- **PASS:** Tab 1 shows the expired page (not a stack trace) and recovery works. **FAIL:** a 5xx, or Tab 1 silently signs in *as a different transaction*.

### A10 — *(optional, slow)* Idle at Keycloak for more than 10 minutes `[P2]`
The login cookie lives 10 minutes.
1. Signed out, click **Sign In**, leave the Keycloak form untouched for **11 minutes**, then submit. → ***"Sign-in expired"** page; **Sign in again** works.*

---

## 3. Group B — Admin and infrastructure (QA-038, QA-030, QA-026)

**Needs an `admin` account (see S0).** Open **`https://wa-app.newfire.app/admin`** or **`https://wa-app.newfire.app/platform-admin/`**. The page has four tabs — **Integrations · Users & Tenants · Finance · Infrastructure**. B1 uses **Infrastructure**; **B2 and B4 use the Finance tab** (that is where the reconciliation and ledger-account cards live).

**Why.** `server` now sends a shared secret to `recon-worker` and the ledger bridge, and both now **refuse** requests without it. If `server` had forgotten to send it anywhere, the failure would show up here as a red banner or a red tile.

### B1 — Infrastructure status `[P0]`
1. Click the **Infrastructure** tab. → *A grid titled **Infrastructure Status**; each tile shows a name, a green ✓ or red ✗, and a latency in ms.*
2. Click **Refresh**.
- **EXPECT GREEN** (tile names are shown capitalised, e.g. `TigerBeetle`, `ReconWorker`): `postgres`, `redis`, `tigerBeetle`, `reconWorker`, `keycloak`. **Anything else:** just note red/green (many are not deployed).
- **WATCH FOR:** `tigerBeetle` or `reconWorker` red with an error such as `401` or `403` (that would mean a caller lost the secret); latencies above ~1000 ms.
- **PASS:** those five are green. **FAIL:** any of them red.

### B2 — Run Reconciliation `[P0]`
This is the button that exercises the secret end to end: browser → `server` → `recon-worker`.
> ⚠️ It runs a real reconciliation pass, including its repair step (voiding orphaned pending ledger reservations for failed/cancelled payments). The recent automatic runs reported `repairs_attempted: 0`, so I expect it to do nothing destructive — but it *can* act on live ledger data, which is why I am telling you.

1. Click the **Finance** tab and find the card **Financial Reconciliation**. Note the `completed_at` in the JSON block under it (if any) and the current time.
2. Click **Run Reconciliation**. → *The button reads **Running…** with a spinning icon, then returns to **Run Reconciliation**.*
3. → ***No red banner** reading "Reconciliation failed: …".*
4. **Reload the page**, return to the Finance tab. → *The JSON now has a `completed_at` **after** your click. Expect: `discrepancies: 0`, `repairs_attempted: 0`, `alerts: []` (the exact `total_checked` depends on the data).*
- **WATCH FOR:** a red banner containing **`401`** or "recon-worker responded HTTP …" (the secret is not being sent); the button stuck on **Running…** for more than ~30 s.
- **EVIDENCE:** screenshot of the card before and after; the Network row for `triggerReconciliation` (status and body).
- **PASS:** no banner, fresh `completed_at`. **FAIL:** any banner, or no fresh timestamp.

### B3 — Service Health page `[P1]`
1. Open `https://wa-app.newfire.app/health`. → *A page listing services. Find the **TigerBeetle** row ("Double-entry financial ledger…").*
- **EXPECT:** TigerBeetle online. **PASS:** online. **FAIL:** offline.

### B4 — The ledger accounts card has no Provision button `[P2]`
1. **Finance** tab → card **TigerBeetle Ledger Accounts**. → *A short grey line: **"Accounts are created automatically the first time a tenant transacts."** and, below it, either a table or "No accounts recorded here yet". There is **no** "Provision Float Account" button.*
- **WATCH FOR:** the button being there (then the old code is running), or a red error in the Console.
- **PASS:** the note is shown and there is no button. **FAIL:** the button is present.
- *(Why: the old button always failed silently; "fixing" it would have created accounts that nothing uses and that can never be deleted from the shared ledger. See QA-039 item 4.)*

---

## 4. Group C — Roles and tenant isolation (QA-028, QA-017, QA-015)

**Why.** Several routers used to expose platform-wide data (all tenants' revenue, dispute queues, the raw inbound-WhatsApp queue…) to *any* logged-in user. They are now admin-only, and per-order reads are tenant-checked.

### C1 — A non-admin is refused the admin portal `[P0]`
- **ROLE:** non-admin (`role: "user"` per S0).
1. Open `https://wa-app.newfire.app/admin`. → *A shield icon, **"Access Restricted"**, "This page requires administrator privileges.", and a badge **"Your role: user"**.*
- **PASS:** that page, no admin controls visible. **FAIL:** any admin tab or tile visible.

### C2 — A non-admin sees no platform-wide data `[P1]`
1. As the **non-admin**, open each of: `/revenue`, `/cogs-disputes`, `/ml-ops`, and (if reachable) `/webhook-dlq`. → *An error / empty state / redirect. **No** tenant names, GMV figures, phone numbers or message text from other tenants.*
2. As the **admin**, open the same pages. → *Data loads.*
- **WATCH FOR:** the non-admin seeing a table of tenants, revenue totals or raw message payloads. (Some of these pages still appear in the merchant navigation; they are admin screens and *should* show an error to non-admins — that is a known UX wart, not a failure.)
- **PASS:** non-admin sees no platform data. **FAIL:** they see any.

### C3 — Another tenant's order is not readable `[P1 · needs two tenants]`
1. As **tenant B** open **Orders** and note an order number (e.g. `ORD-…`).
2. Sign out; sign in as **tenant A** (a *different* tenant).
3. Open `https://wa-app.newfire.app/orders/<that order number>`. → *"not found" / forbidden; **no** items, totals, payments or customer details.*
- **PASS:** nothing from tenant B shown. **FAIL:** any order content visible.

---

## 5. Group D — Resilience while you use the UI (I cause the disruption)

**You drive the UI, I drive `kubectl`.** Say **"starting D1"** and I will confirm I'm ready; then keep clicking and tell me **"done"** when told. Do these **last**, and only when you have ~20 uninterrupted minutes.

### D1 — Lose one `server` replica while you click `[P0]`
- **Setup:** signed in; a page with several tabs/widgets open (e.g. `/dashboard`); Network tab filtered to `trpc`.
1. Say **"starting D1"**. I delete one of the two `server` pods (a normal, graceful delete).
2. For **60 seconds** keep clicking between pages.
- **EXPECT:** no full-page error, you stay signed in, at most **one** failed request (which retries / recovers on the next click).
- **PASS:** you never had to sign in again and every page loaded within a couple of retries. **FAIL:** a stuck error page, forced re-login, or >1 minute of failures.

### D2 — The ledger bridge is down while you click `[P0]`
This is the "a ledger outage must not take the platform down" guarantee.
- **Setup:** signed in, on `/dashboard`.
1. Say **"starting D2"**. I scale `ledger-bridge` to 0 for ~90 seconds. (I checked the live alert rules: `ComponentDown`, `TigerBeetleOpErrors` and `TigerBeetleUnreachable` all need **5 minutes** sustained, and the last one probes the *shared* TigerBeetle, not our bridge — so this cannot page anyone. The new fast ledger alert in `docs/handoff/monitoring-alerts-whatsapp-commerce.yaml` is **not live**: it belongs to another repo.)
2. While it is down, click through **Dashboard, Products, Conversations, Orders, Tenants**. → *All load normally. Open `https://wa-app.newfire.app/health/ready` → still returns 200 — the ledger is reported as *degraded*, not as a reason to fail readiness (that is deliberate).*
3. On **Infrastructure → Infrastructure Status**: `tigerBeetle` tile turns **red** (correct — the bridge is down).
4. I scale it back. → *Within ~30 s the tile returns to green **without anything being restarted**.*
- **PASS:** ordinary pages keep working throughout and it recovers by itself. **FAIL:** ordinary pages error, or the site goes down.

### D3 — A rolling restart while you click `[P1]`
1. Say **"starting D3"**. I run a rolling restart of `server` (never fewer than the desired number of pods).
2. Keep clicking for **~2 minutes**.
- **EXPECT:** essentially uninterrupted; a single failed request is acceptable; you are **not** signed out.
- **PASS:** no visible outage, still signed in. **FAIL:** an outage of more than a few seconds, or a forced sign-in.

---

## 6. Group E — Input security you can see in the browser

### E1 — The Keycloak setup form refuses internal addresses (SSRF guard, QA-016) `[P1]`
The server used to POST a tenant's real client secret to whatever URL the tenant typed. It now refuses private/loopback/link-local addresses.
- **ROLE:** admin, or a tenant owner/operator (the Keycloak test call needs the operator role). **Tenant ID:** any tenant id you can access — `tenantId` from S0.
1. Open `https://wa-app.newfire.app/setup`. Choose the **Keycloak** card.
2. Fill **Keycloak Server URL** = `http://169.254.169.254`, **Realm Name** = `x`, **Client ID** = `x`, **Tenant ID** = your tenant id (from S0). Leave the secret blank.
3. Click **Test Connection**. → *A failure message — ideally mentioning "SSRF guard rejected" or a blocked/private address (the exact wording is the server's; I haven't seen this form's rendering of it). It must **not** report a successful connection or hang.*
4. Repeat with `http://localhost:8080` and `http://10.0.0.1`.
- **PASS:** all three rejected. **FAIL:** any attempts a connection.

---

## 7. Group G — Smoke sweep (regression)

The server image was rebuilt four times today, so a plain "does every page still load" pass is worth having.

### G1 — Load ~16 pages `[P1]`
For **each** path: open it, wait for it to settle, then note (a) does it render, (b) any **red error banner**, (c) any red line in the Console, (d) any Network row to `/api/trpc/...` with status **5xx**.

`/dashboard` · `/tenants` · `/products` · `/conversations` · `/orders` · `/payments` · `/escrow` · `/invoices` · `/integrations` · `/inventory` · `/broadcast` · `/reconciliation` · `/health` · `/system-health` · `/audit-logs` · `/tenant-settings`

- **EXPECT:** empty states ("No orders yet") are fine; a permission message for a non-admin on an admin-only page is fine; **5xx responses and uncaught exceptions are not.**
- **Report only the failures:** `G1 FAIL /payments  red banner "…"  [screenshot]  [Network: POST /api/trpc/payment.list → 500 body: …]`.
- **PASS:** no 5xx and no uncaught console errors. **FAIL:** any.

---

## 8. What happens after you report

- **Any FAIL:** I use your timestamp to pull the matching server / bridge / recon-worker log lines, find the cause, fix it, redeploy, and give you the single test to re-run.
- **All of Group A passing** means QA-020 is verified end to end (the one item I marked "not verified: an interactive login with real credentials").
- **Not covered here on purpose:** the payment/ledger money flow from a real customer payment, TigerBeetle failover with a user mid-session (shared infrastructure — needs the owner's say-so), and the shared TigerBeetle / Postgres namespaces having no network policy.
