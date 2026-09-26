# UI test plan — round 1 (2026-09-21)

**Purpose.** Everything in this plan is something I could **not** prove from a terminal: a real browser, a real Keycloak login, what a person actually sees. I have already verified everything a terminal can prove (table below), so nothing here is busywork.

**Update 2026-09-25 — Groups V and W added ("Follow the data", "Telegram").** Groups A–G (and H–U in the tracker) check that the screens *work*. Group **V** checks where the data *goes*: you do something in the app, then look for it in Postgres, Redis, Kafka, Temporal, the logs and the traces — and, just as important, confirm that the stores that should **not** move, don't. Section 0.6 and test B2 were also corrected (a recurring reconciliation alert; see below).

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
| Build under test | *(updated 2026-09-25)* `server:qa-local35` (2 replicas, HPA 2–4); `ledger-bridge`, `recon-worker`: `qa-local4`; `commerce-engine`: `qa-local2`; `temporal-worker`: `qa-local2`. Groups A–G were written against `qa-local8`; the login, sidebar and 403 fixes they test are still in. |

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
- **(Added 2026-09-25)** From the **web UI alone**, **Kafka, Fluvio and Temporal do not move** (Group V, test V7). Events are only emitted by an inbound WhatsApp message (`wacommerce.conversations`), the order-create API (no screen calls it) and payments (not startable from the UI). Empty Kafka topics and an idle Temporal namespace are correct, not a fault.
- **(Added 2026-09-25)** The **Fluvio** consumer reads events but drops them at its forward step (its platform address was never configured) — deliberately left as is for now. Don't report "nothing from Fluvio in the event log".
- **(Added 2026-09-25)** The **Temporal web UI** (`temporal-web.newfire.app`) has **no login** today (open to the internet). Known; fix is `./k8s-tools/apply.sh --secure-temporal`.
- **(Added 2026-09-25) KNOWN ISSUE — one shared rate-limit bucket.** Every browser request is counted under the **API gateway's internal address**, not under you or your business, so all users share one limit of 200 requests/minute (per gateway pod). You will *see* this in V1. Report what you see there, but it is already recorded.

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
| **F1** | Register a brand-new account and see YOUR details in the sidebar | none (you register) | 6 | QA-043 |
| **F2** | A new user gets the set-up screen, not a wall of 403s | the F1 account | 4 | QA-043 |
| **F3** | Create the business; the sidebar and pages switch to it | the F1 account | 8 | QA-043 |
| **F4** | A merchant's pages load with **no 403s** | the F1 account (after F3) | 8 | QA-043 |
| **F5** | The sidebar is present everywhere it should be | any signed-in | 5 | QA-043 |
| **F6** | Admin-only links: admin sees them, a merchant does not | admin + merchant | 4 | QA-043 |
| **G1** | Smoke sweep of ~16 pages | admin (+ non-admin) | 20 | regression |
| **V0** | Open the seven windows (Postgres, Redis, Kafka, Temporal, logs, traces) | shared login + DB password | 10 | set-up |
| **V1** | One page view leaves exactly this trail — and shows the shared rate-limit key | any signed-in | 8 | data flow |
| **V2** | Signing in updates your user row | any account | 4 | data flow |
| **V3** | Creating the business writes exactly these rows | the F1 account (**non-admin**, no business yet) | 8 | data flow |
| **V4** | A manual stock correction writes exactly these rows | merchant with a product | 8 | data flow |
| **V5** | An admin plan change is audited (row + hash chain) | admin | 8 | data flow |
| **V6** | Run Reconciliation leaves events and log lines | admin | 6 | data flow |
| **V7** | What should **not** move: Kafka, Temporal, extra Redis keys, other tables | after V1–V6 | 6 | data flow |
| **V8** | *(optional)* An inbound WhatsApp message appears in Kafka | a phone + a connected WhatsApp number | 10 | data flow |

**Suggested order:** S0 → A1–A9 → **F1–F6 (the account/403/sidebar fixes — do these early, they need a fresh account)** → B1–B3 → G1 → **V0 → V1–V7 (V8 if you have WhatsApp)** → C → E1 → D (D last, because I disturb the cluster).

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
4. **Reload the page**, return to the Finance tab. → *The JSON now has a `completed_at` **after** your click. Expect (as of 2026-09-25): `discrepancies: 1`, `repairs_attempted: 0`, and **one alert** about payment `906ef56e…` — a ₦5,000 **wallet top-up** completed on 2026-09-24 that has no ledger tracking. That alert repeats on every pass (it has been raised ~280 times) and is **not** a B2 failure; it is a reconciliation-rule question I have raised separately. `total_checked` depends on the data. If you ever see `discrepancies: 0`, `alerts: []`, that is also fine (it means the top-up was resolved).*
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

## 6a. Group F — Registration, the sidebar, the 403s (QA-043)

**What was wrong, in one paragraph.** The app's front end picked a business for you (a hard-coded demo tenant, `tenant-001`) instead of asking who you are, so almost every merchant page sent the wrong business and the server refused it with a **403**. A newly registered account has no business at all, so *every* page did that. Several pages had no sidebar, the sidebar showed "User" (or an internal id) instead of your details, and two links (Escrow, Revenue) only work for admins. All fixed in `server:qa-local9`. **You need a fresh account for F1–F4** (the point is what a brand-new user sees), so use the **Register** link on the sign-in form (see §0.3).

**Set-up for all of F:** DevTools open, **Network** tab, filter box: `trpc`, and tick **Preserve log**. A 403 shows as a red row with status **403**.

### F1 — Register, and see your own details in the sidebar `[P0]`
1. Private window → `https://wa-app.newfire.app/tenant-portal/` → **Sign In** → on the Keycloak form click **Register**. Fill it in with a real email, a first and last name, and a password; submit (verify the email if it asks).
2. → *You come back to the app, signed in.*
3. Look at the **bottom of the left sidebar**. → ***Three lines:** your name (first + last as you typed them), your email, and **"No business yet"**.* Click it: the menu opens with the same three lines at the top, then **Sign out** (there is **no Settings** item yet — you have no business).
- **WATCH FOR:** the name showing as **"User"**, a long random id, or just your email twice; the third line missing; a blank avatar letter.
- **PASS:** name + email + "No business yet". **FAIL:** anything else (screenshot it).
- *Also try:* register a second account with **no** first/last name if the form lets you. → *The name line shows the part of your email before the `@`, never "User".*

### F2 — A new user gets a set-up screen, not a wall of red errors `[P0]`
1. Still signed in as the new account. Look at the page in the middle. → ***"Welcome, {your name}"** and a big **Set up your business** button.*
2. Look at the left navigation. → *A single group, **Get started → Set up your business**. **No** Products / Orders / Conversations / Payments.*
3. In the address bar go to `https://wa-app.newfire.app/tenant-portal/products`. → *The same "Welcome / Set up your business" screen (you are not sent to an error page).*
4. Network tab. → ***No red 403 rows.** (Before the fix you would see several `403` responses on every page.)*
- **PASS:** set-up screen, one nav entry, zero 403s. **FAIL:** any 403, a blank page, or the merchant navigation.

### F3 — Create the business; the sidebar and pages switch to it `[P0]`
1. Click **Set up your business** → the wizard opens (the sidebar is still there).
2. Enter a business name (e.g. `QA Test Stores`) and continue past the first step. → *A green toast, something like `Tenant "QA Test Stores" provisioned`.*
3. Look at the sidebar without reloading. → ***The full merchant navigation appears**, the sidebar's top shows **QA Test Stores**, and the account block's third line changes from "No business yet" to **QA Test Stores**.*
4. Reload the page (**⌘R**). → *Same: business name shown, full navigation.*
- **WATCH FOR:** having to sign out and in to see the change; the third line still saying "No business yet".
- **PASS:** it switches without a manual reload, and survives one. **FAIL:** otherwise. (Note the time if it needs a reload — that is a bug I need to look at.)

### F4 — A merchant's pages load with no 403s `[P0]`
As the F3 account, open each of these and watch the Network tab (`trpc` filter): `/products`, `/orders`, `/conversations`, `/payments`, `/invoices`, `/tenant-settings`, `/broadcast`, `/consents`, `/journeys`, `/analytics-bi`, `/mobile-money`, `/wholesale`, `/group-deals`.
- **EXPECT:** pages load (empty states like "No orders yet" are fine); **no row with status 403**.
- **A 403 is a FAIL** — send me the page, the row's URL (the part after `/api/trpc/`) and the response body. A **401** is a different thing (signed out); a **400** is a form validation message.
- *(These are the pages that used to hard-code or default to the demo tenant.)*

### F5 — The sidebar is present everywhere it should be `[P1]`
1. `https://wa-app.newfire.app/tenant-portal/wholesale` and `/tenant-portal/group-deals`. → ***The sidebar is there** on both. (These two used to render without one.)*
2. Open the account menu (bottom of the sidebar) → **Settings** (once you have a business, F3). → *Tenant Settings page, **with** the sidebar. (It used to go to a "Page Not Found" screen with no sidebar.)*
3. Go to `.../tenant-portal/this-page-does-not-exist`. → *"404 Page Not Found" **inside** the sidebar layout.*
4. Signed out, `https://wa-app.newfire.app/track/anything` and the storefront `https://wa-app.newfire.app/shop/anything`. → *These stay **bare** on purpose (public links) — that is correct, not a bug.*
- **PASS:** 1–3 have the sidebar, 4 does not.

### F6 — Admin-only links `[P1]`
- As a **merchant** (F3 account): open the **Payments** group in the sidebar. → ***No "Escrow" and no "Revenue".** (Both only work for admins; they used to be there and return 403.)*
- As an **admin** (needs S0/promotion): the same group. → ***Escrow and Revenue are there** and load.*
- **PASS:** the two behave as described. **FAIL:** a merchant sees them, or an admin does not.

## 7. Group G — Smoke sweep (regression)

The server image was rebuilt four times today, so a plain "does every page still load" pass is worth having.

### G1 — Load ~16 pages `[P1]`
For **each** path: open it, wait for it to settle, then note (a) does it render, (b) any **red error banner**, (c) any red line in the Console, (d) any Network row to `/api/trpc/...` with status **5xx**.

`/dashboard` · `/tenants` · `/products` · `/conversations` · `/orders` · `/payments` · `/escrow` · `/invoices` · `/integrations` · `/inventory` · `/broadcast` · `/reconciliation` · `/health` · `/system-health` · `/audit-logs` · `/tenant-settings`

- **EXPECT:** empty states ("No orders yet") are fine; a permission message for a non-admin on an admin-only page is fine; **5xx responses and uncaught exceptions are not.**
- **Report only the failures:** `G1 FAIL /payments  red banner "…"  [screenshot]  [Network: POST /api/trpc/payment.list → 500 body: …]`.
- **PASS:** no 5xx and no uncaught console errors. **FAIL:** any.

---

## 7a. Group V — Follow the data (a UI action → every store)

**Why this group exists.** A test can pass ("Stock updated") while the data went nowhere, went somewhere unexpected, or moved something that should have stayed still. Here you do one small thing in the app, then look for it in **every place data can land** — and confirm that the places it *shouldn't* land stay quiet.

**How I know what "expected" is.** I ran the real server code for each action on a scratch database and diffed **every table** before and after, then checked each query and the Redis key against the live system. The "expected" columns below are measured, not guessed. One thing they showed: from the web UI, **only Postgres changes** (plus a Redis counter) — Kafka, Fluvio and Temporal are not touched by any screen (test V7 makes you confirm that).

**Report format for V:** one line per test, plus the numbers you saw — e.g. `V4 PASS  stock_adjustments +1 (delta 12), stockQuantity 37, Redis +6, trace trpc.inventory.adjustStock`. For any **FAIL** send the query you ran and its result grid (screenshot), and the time in UTC.

### V0 — Open the seven windows (once) `[set-up]`

Keep them side by side. Times in the database are **UTC**.

| # | Window | Address | Sign-in | What it shows |
|---|---|---|---|---|
| **W1** | **The app** | `https://wa-app.newfire.app/tenant-portal/` (and `/platform-admin/`) | Keycloak (Group A) | what you drive |
| **W2** | **Postgres** (Adminer) | `https://pg-ui.newfire.app` | shared login, then the database form (below) | every table |
| **W3** | **Redis** (RedisInsight) | `https://redis-ui.newfire.app` | shared login | rate-limit counters |
| **W4** | **Kafka** (Kafka UI) | `https://kafka-ui.newfire.app` | shared login | topics and messages (read-only) |
| **W5** | **Temporal** | `https://temporal-web.newfire.app` → namespace `whatsapp-commerce` | none today (known) | workflow runs |
| **W6** | **Logs** (Grafana → Loki) | `https://grafana.newfire.app` → *Explore* → data source *Loki* | Grafana's own login — currently answers **401**; ask the owner for one | server / worker log lines |
| **W7** | **Traces** (Jaeger) | `https://jaeger.newfire.app` | answers **401** too — same | one request's path through the server |

**Shared login (W2, W3, W4):** username `cluster-admin`; password:
```bash
kubectl --context kind-newwave-dev -n cluster-tools get secret cluster-tools-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
```
**W2, second step — the Adminer form:** System **PostgreSQL** · Server `pg-oracle-rw.postgres-oracle.svc.cluster.local` · Username `whatsapp` · Database `whatsapp_commerce` · Password:
```bash
kubectl --context kind-newwave-dev -n whatsapp-commerce get secret whatsapp-postgres-dsn -o jsonpath='{.data.DATABASE_URL}' | base64 -d | python3 -c 'import sys,urllib.parse as u; print(u.urlparse(sys.stdin.read().strip()).password)'
```
Then click **SQL command** in the left menu, paste a query, **Execute**. ⚠️ **This login can change data — run `SELECT`s only.** (A read-only database role is still on the to-do list.) Don't paste either password into chat.

**W3:** open the database **"shared redis (ns redis)"** → **Browser**. That Redis is **shared with other projects** (you will see other teams' keys) — look, but do not delete or edit anything.

**W4:** cluster `mojaloop-kafka` → **Topics** → search `wacommerce`. Open a topic → **Messages**. This Kafka is also shared; most topics belong to other projects.

**W6:** query `{namespace="whatsapp-commerce", container="server"}` (others: `recon-worker`, `temporal-worker`, `fluvio-consumer`). A *successful* click logs little or nothing — the server logs errors and notable events, not every request. Use **W7** to see a successful request.

**W7:** Service **`whatsapp-commerce-platform`** → Lookback *Last hour* → **Find Traces**. Span names look like `trpc.<router>.<procedure>` (e.g. `trpc.tenant.myTenant`).

**Sanity check (2 min) — you can see something in each window:** W2 `select count(*) from tenants;` returns a number · W3 lists keys · W4 lists topics · W5 lists workflow runs · W7 shows the service. **If a window is empty or refuses you, stop and tell me — every later test needs it.**

### The map — where each action should leave data

Read a row as: *"if I do this in the app, it must show up where there is a ✔-style entry, and **nowhere** where there is a —."*

| You do | Postgres (W2) | Redis (W3) | Kafka (W4) | Temporal (W5) | Trace (W7) |
|---|---|---|---|---|---|
| Load or click any page | **nothing written** | `rl:trpc:*` counter +1 per request | — | — | `trpc.<router>.<procedure>` |
| Sign in | your `users` row (`lastSignedIn`) | as above | — | — | the auth callback |
| Create the business | `tenants` +1 · `tenant_memberships` +1 (role `owner`) · your `users.tenantId` set | as above | — | — | `trpc.onboarding.start` |
| Manual stock correction | `products."stockQuantity"` updated · `stock_adjustments` +1 (and `inventory_snapshots` if a row exists). **No audit row.** | as above | — | — | `trpc.inventory.adjustStock` |
| Admin changes a tenant's plan or status | `audit_logs` +1 · `audit_chain` +1 · the `tenants` row | as above | — | — | `trpc.tenant.update` |
| Run Reconciliation | `fluvio_event_log` +2 (`recon.run_completed`, `recon.alert`) | — | — | — | `recon-worker` service |
| Inbound WhatsApp message | conversation rows | — | `wacommerce.conversations` +1 | — | the webhook request |

**"—" means nothing should happen there.** If something does, that is a finding — tell me. Payments are not in the table: they cannot be started from the web UI.

### V1 — One page view leaves exactly this trail `[P0]`
*Needs: any signed-in account · windows W1, W3, W7 (and W2).*
1. **W3:** Browser → filter box `rl:trpc:*` → click refresh (⟳). → *Zero or a few keys. Write down each key, its count and its TTL.*
2. **W1:** DevTools → **Network** → filter `trpc` → clear (🚫). **Reload the Dashboard once (⌘R).** Count the rows whose URL contains `/api/trpc/` — call that number **N**.
3. Within **60 seconds**, **W3** → refresh. → *A key shaped `rl:trpc:<who>:<minute-number>` whose **count went up by about N**, with a **TTL of at most 60 s**. (It counts HTTP requests — one Network row each, even when a row carries several batched calls. A few more is fine if the page polls in the background.)*
4. **W7:** Find Traces. → *Traces named `trpc.<router>.<procedure>` from the last minute or two.*
5. **W2:** run `select max(created_at) as last_audit from audit_logs;` and `select count(*) from stock_adjustments;` **before and after** the reload. → *Identical. A page view writes nothing.*
6. *(This is the test that shows the known issue.)* Open a **Private window**, sign in as a **different** account, and reload a page. Refresh **W3**. → *Today, the **same key's** count goes up again.*
- **WATCH FOR / what you will see today:** `<who>` is the **API gateway's internal address** (it looks like `::ffff:10.244.1.207`), **not you and not your business.** That is the known issue in 0.6: every user is counted in one bucket of 200 requests a minute. **After the fix** the key should be per user or per business.
- **PASS (today):** the key exists, its count rose by about N, TTL ≤ 60 s, a trace exists, nothing new in Postgres — and you have recorded what `<who>` showed. **FAIL:** the count never moves (the limiter isn't counting), a row appeared in Postgres, or there is no trace at all.
- **EVIDENCE:** W3 before/after screenshot; the W7 trace list.

### V2 — Signing in updates your user row `[P1]`
*Needs: any account · W1, W2.*
1. **W2:** `select id, email, "tenantId", "lastSignedIn" from users order by "lastSignedIn" desc limit 5;` → *Find your email (or note that it is not there yet, if this is a brand-new registration). Write down the `lastSignedIn` time — UTC.*
2. **W1:** sign out and sign in again (as in A8). Note the time.
3. **W2:** run the query again. → *Your row is at the top and `lastSignedIn` is within a minute of your sign-in. For a brand-new registration (F1): a new row with your email exists and `tenantId` is empty until V3.*
- **PASS:** as above. **FAIL:** no row for your email after signing in, or `lastSignedIn` did not move.

### V3 — Creating the business writes exactly these rows `[P0]`
*Needs: the **F1 account — a non-admin with no business yet** · W1, W2, W3, W7. (An **admin** creating a business gets no membership row — admins aren't tied to one business — so do not use an admin here.)*
1. **W2 (before):** run these three and write down the counts / values:
   ```sql
   select count(*) from tenants;
   select count(*) from tenant_memberships;
   select id, email, "tenantId" from users where email = 'YOUR-EMAIL';
   ```
   → *`tenantId` is empty (null).*
2. **W1:** do **F3** — *Set up your business* → name it **`QA Data Trace`** → continue past the first step. → *Toast `Tenant "QA Data Trace" provisioned`.*
3. **W2 (after):** run
   ```sql
   select id, name, slug, plan, status, "createdAt" from tenants order by "createdAt" desc limit 3;
   select id, "tenantId", "userId", role, "createdAt" from tenant_memberships order by "createdAt" desc limit 3;
   select id, email, "tenantId" from users where email = 'YOUR-EMAIL';
   ```
   → ***One** new `tenants` row* (name `QA Data Trace`, a slug made from it) · ***one** new `tenant_memberships` row* with `tenantId` = that new tenant, `userId` = your `users.id`, role **`owner`** · *your `users."tenantId"` now equals the new tenant's id.*
4. **W2:** `select action, entity_type, created_at from audit_logs order by created_at desc limit 3;` → *No new row for this. (Creating a business is **not** audited today — that is expected.)*
5. **W7:** trace `trpc.onboarding.start`. **W3:** the `rl:trpc:*` count went up. **W4, W5:** nothing new.
- **WATCH FOR:** **two** `tenants` rows (a double-click created it twice) · **no** membership row (you would be locked out of your own business) · role other than `owner` · your `users."tenantId"` showing **`__claiming__`** (a temporary marker that must never remain) · a `tenants` row but your `tenantId` still empty.
- **PASS:** exactly one tenant, one `owner` membership, `users."tenantId"` set. **FAIL:** anything else — screenshot the three result grids.

### V4 — A manual stock correction writes exactly these rows `[P0]`
*Needs: a merchant with a business and at least one product · W1, W2, W7.*
1. **W1:** open **Inventory** (`/inventory`). Pick a product; call its current quantity **Q**.
2. **W2 (before):** `select id, name, "stockQuantity" from products where name = 'PRODUCT NAME';` and `select count(*) from stock_adjustments;`
3. **W1:** on that product's row click the **Correct stock count** icon → the **Adjust Stock** dialog → **New Quantity** = **Q + 12** → **Reason** = *Count* → **Note** = `V4 data trace` → save. → *Toast **"Stock updated"**; the row shows the new quantity.*
4. **W2 (after):**
   ```sql
   select id, product_id, delta_qty, reason, note, actor_id, created_at from stock_adjustments order by created_at desc limit 3;
   select id, name, "stockQuantity" from products where name = 'PRODUCT NAME';
   ```
   → ***One** new `stock_adjustments` row: `delta_qty` = **12**, `reason` = `count`, `note` = `V4 data trace`, `actor_id` = your user id* · *`stockQuantity` = Q + 12.*
5. **W1:** open the same dialog, type the quantity that is **already** there, save. **W2:** `select count(*) from stock_adjustments;` → *Unchanged — a "no change" leaves no row.*
6. **W2:** `select count(*) from audit_logs;` before and after step 3 → *Unchanged. Stock corrections are recorded in `stock_adjustments`, **not** in the audit log.* **W4:** no `wacommerce.inventory` topic and no new messages · **W5:** nothing. → *Corrections emit no event (as designed today).*
7. **W7:** trace `trpc.inventory.adjustStock`.
8. **Put it back:** correct the quantity to **Q**. → *A second `stock_adjustments` row with `delta_qty` = **−12**.*
- **If the icon is greyed** with the tooltip *"Your role doesn't have the catalog capability"* — that is the permission working; use an owner account.
- **WATCH FOR (the serious one):** `stockQuantity` changed but there is **no** `stock_adjustments` row (an untracked change to stock), or a row for a "no change" save, or a `delta_qty` that isn't new − old.
- **PASS:** rows exactly as stated, including the −12 reversal. **FAIL:** anything else.

### V5 — An admin plan change is audited (row + hash chain) `[P1]`
*Needs: an admin account · W1, W2, W7. Use the business you created in V3 — **not a real customer**.*
1. **W2:** `select id, name, plan, status from tenants where name = 'QA Data Trace';` → *Write down the id and the current plan.*
2. **W1 (admin):** `/platform-admin/tenants` → open **QA Data Trace** → change **Plan** to a value **different** from the current one → **Save Changes**. → *Toast **"Tenant updated"**.*
3. **W2:**
   ```sql
   select id, actor_id, actor_role, action, entity_type, entity_id, summary, before, after, created_at from audit_logs order by created_at desc limit 3;
   select * from audit_chain order by 1 desc limit 2;
   select id, name, plan, status from tenants where name = 'QA Data Trace';
   ```
   → ***One** new `audit_logs` row: `action` `tenant.update`, `entity_type` `tenant`, `entity_id` = that tenant, `actor_id` = your admin user; `summary` lists the fields sent and any status change; `before` and `after` hold the old and new values (the plan differs)* · ***one** more `audit_chain` row* (the tamper-evident hash chain) · *`tenants.plan` = your new value.*
4. **W1:** `/platform-admin/audit-logs`. → *The same entry at the top.*
5. Change the plan **back**. → *A second audit row (the change and its reversal).*
- **Good to know:** saving with the **same** value still writes an audit row today (a no-op is audited) — fine.
- **WATCH FOR:** a plan change with **no** audit row · an audit row with empty `before`/`after` · a non-admin able to do this at all (that would fail C1).
- **PASS:** audit row + chain row + new plan. **FAIL:** any missing.

### V6 — Run Reconciliation leaves events and log lines `[P1]`
*Needs: an admin account · W1, W2, W6. (This is test B2's button, with the trail checked.)*
*Note: the table is called `fluvio_event_log`, but these rows come straight from the **recon worker** — Fluvio itself is not involved.*
1. **W2:** `select topic, event_type, received_at, payload from fluvio_event_log order by received_at desc limit 4;` → *Note the newest `received_at` (UTC).*
2. **W1 (admin):** do **B2** — Finance tab → **Run Reconciliation**.
3. **W2:** run the query again. → *Two new rows timed at your click: **`recon.run_completed`** (payload: `runId`, `matched`, `discrepancies`, `total_checked`, `repairs_attempted`) and **`recon.alert`** (today: the wallet top-up alert from 0.6). If the automatic 5-minute pass lands within seconds of your click you may see two pairs.*
4. **W6:** `{namespace="whatsapp-commerce", container="recon-worker"}`. → *Log lines around the time of your click.*
5. If the Service Health / Infrastructure page lists recent events, **W1:** open it. → *The same events appear.*
- **PASS:** a fresh `recon.run_completed` row at your click. **FAIL:** a click with no new rows *and* no automatic pass either.

### V7 — What should **not** move `[P1]`
*Do this **after** V1–V6. Needs: W2, W3, W4, W5.* The point: prove the web UI didn't quietly start anything else.
1. **W4:** open `wacommerce.orders`, `wacommerce.conversations` and `hermes.events.inbound`. → *Message counts are **unchanged** (0). No `wacommerce.inventory` or `wacommerce.payments` topic has appeared. (`wacommerce.verify` with 3 messages is my earlier test topic — ignore it.)*
2. **W5:** namespace `whatsapp-commerce`. → *No workflow started since you began. The only runs are the earlier `verify-journey-neg-…` ones from my checks and the first pilot runs.*
3. **W3:** clear the filter and look at the keys. → *Only `rl:…` keys are new (`rl:trpc:*` from your clicks). No new key families from the app (nothing like `session:…` or `cart:…`); other projects' keys are theirs.*
4. **W2:** `select count(*) from fluvio_event_log where topic not like 'recon.%';` → ***0.** No real Fluvio event has ever been recorded (known — see 0.6).*
- **PASS:** nothing moved. **FAIL / finding:** anything moved — tell me which store, and what you did just before.

### V8 — *(optional)* An inbound WhatsApp message appears in Kafka `[P2]`
*Needs: a phone and a tenant whose WhatsApp number is connected · W1, W2, W4. If no number is connected, mark it **BLOCKED**.*
1. **W4:** open `wacommerce.conversations` → *note the message count (it is 0 today).*
2. From your phone, send **`hi`** to the business's WhatsApp number.
3. Within ~10 seconds, **W4** → **Messages**. → ***One** new message: key = a long WhatsApp message id (`wamid…`); value like `{"conversationId":"wamid…","tenantId":"…","eventType":"wa.messages.inbound","from":"<your number>","textBody":"hi", …, "_ts":…}`.*
4. **W1:** the **Conversations** page. → *Your conversation, with "hi".* **W2:** `select id, "tenantId", status, channel, "messageCount", "createdAt" from conversations order by "createdAt" desc limit 3;` → *A new or updated row.*
5. **W5:** nothing new.
- **Note (privacy):** the message text and your phone number sit **in plain text** in Kafka (kept 7 days), readable by anyone with the shared login. That is how it works today; tell me if it should not.
- **PASS:** the Kafka message, the conversation row, and nothing in Temporal. **FAIL:** the conversation appears in the app but **not** in Kafka.

---

## 7b. Group W — Telegram (engineer sheet)

The tester-facing steps (W0–W12) live in the tracker add-on; this section is the part only an engineer can do. **State on 2026-09-25, updated (build `qa-local37`, live):** `TELEGRAM_ENABLED=true` on the server (flipped this session — was off since W37 landed); the webhook now answers past the switch for a configured tenant. The database still has **zero real** Telegram data — no business has connected a real bot yet, only simulation/journey data exists. The cluster can reach `api.telegram.org`. 49 automated Telegram-touching journeys (was 48; added J471, see below) and the related unit tests pass; **the first real end-to-end test with an actual BotFather bot is still outstanding** — needs a business owner to run the UI steps in §7c below with a real token.

**How it fits together.** `POST /api/webhooks/telegram/:tenantId` → global switch `TELEGRAM_ENABLED` (must be exactly `true`) → tenant config + stored secret → suspended-tenant check → `X-Telegram-Bot-Api-Secret-Token` (timing-safe) → dedupe claim `tg:<update_id>` in `processed_webhook_events` → 200 ack → processing after the ack → **as of `qa-local37`: text goes through the SAME menu/session engine WhatsApp uses (`handleConversationalInbound`), taps through `handleInteractiveInbound`, both rendered back as a Telegram inline keyboard/list; anything the engine doesn't handle falls through to the assistant, exactly like WhatsApp's `nlp.processMessage` fallback.** There is now a screen for saving the bot (§7c below, `TelegramSetupCard` on `/integration-settings`); the server still never calls Telegram's `setWebhook` on its own initiative — only when the operator clicks Register webhook.

### 7c. Connect a real bot from the UI (do this first — it's how you'll actually test)

1. In Telegram, message **@BotFather** → `/newbot` → pick a display name, then a username ending in `bot`. It replies with the token immediately.
2. In the app: sidebar → **Configuration** → **Integration Settings** (`/integration-settings`) → the Telegram card. **Nav bug found 2026-09-25:** this card is filed under "Configuration", not under the "Integrations" nav section where you'd expect it — if you only looked under "Integrations" (Integration Hub/Health/CRM/Odoo/Medusa) you'd correctly see nothing Telegram-related, because it isn't there. Not fixed yet.
3. Paste the username (no `@`) and the token, flip **Enabled**, **Save**. The token is never shown again — only `Stored: ••••1234`.
4. **Test connection** — calls Telegram `getMe`, flags a username/token mismatch.
5. **Register webhook** — server calls `setWebhook` with an address it builds itself and a secret it generates; refuses first if the server switch is off, the business isn't enabled, or the app address isn't https.
6. Message the bot from a private Telegram chat. Tap **Start** — you should get the welcome menu directly (not just a bare confirmation). `hi`/`menu`/`help`/`catalog` should show the same tappable menu; order lookup and human handoff should work; a tap should behave like a WhatsApp button tap. Try placing a real order (Shop → add an item → confirm → choose pickup/delivery) — you should get an order summary followed by a Track/Pay/Cancel button card, and tapping Pay should take you to a real payment step.

**Note on the Shop step (added 2026-09-25, `qa-local39`):** the live server currently has **no LLM configured** (`LLM_BASE_URL` unset — QA-051) — this is a pre-existing platform gap, not something Telegram-specific, and it means the free-text ordering assistant has never worked live on WhatsApp either. A **deterministic fallback** now covers it: after tapping Shop, replying with a plain number ("2"), "qty + item name" ("2 jollof rice"), or a full sentence ("I need 2 jollof rice please") still adds the right item to your cart, and "confirm" still creates a real order — you'll see a numbered catalog listing whenever it can't tell what you meant, never a dead end. If a real LLM ever gets configured, this note (and the fallback's behavior) becomes invisible — the natural-language experience takes over automatically.

**Keep the token out of your shell history and out of chat.** `read -s TOKEN` (silent prompt) instead of pasting it into a command line.

```bash
# 0. BEFORE switching anything on (test W0): the closed state
curl -s -X POST -H 'content-type: application/json' -d '{"update_id":1}' https://wa-app.newfire.app/api/webhooks/telegram/anything ; echo
#    expect: {"error":"telegram-disabled"}   (HTTP 404)

# 1. Create the bot in Telegram: @BotFather -> /newbot -> copy the token.

# 2. Switch the feature on for the server (a live env change; reversible)
kubectl --context kind-newwave-dev -n whatsapp-commerce set env deploy/server TELEGRAM_ENABLED=true
kubectl --context kind-newwave-dev -n whatsapp-commerce rollout status deploy/server --timeout=300s
#    revert:  kubectl ... set env deploy/server TELEGRAM_ENABLED-

# 3. Save the bot on a TEST business. Run in the browser console of a signed-in tab of the app
#    (same origin, so the CSRF origin check passes). Use an owner/operator of that business.
fetch('/api/trpc/tenant.updateTelegramConfig', {
  method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({json: {tenantId: 'TEST_TENANT_ID', botToken: 'PASTE_TOKEN_HERE', botUsername: 'your_bot', enabled: true}})
}).then(r => r.json()).then(j => console.log(JSON.stringify(j.result?.data?.json ?? j)))
#    expect {success:true, webhookSecret:"..."}  -- the secret is shown ONCE; copy it now.
#    token format check: ^\d{5,}:[A-Za-z0-9_-]{30,}$ ; a bot already saved on another business -> CONFLICT

# 4. Register the webhook with Telegram (the token never goes on the command line)
read -s TOKEN; read -s SECRET
curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=https://wa-app.newfire.app/api/webhooks/telegram/TEST_TENANT_ID" \
  --data-urlencode "secret_token=${SECRET}"
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"     # url set, pending_update_count 0, no last_error_message

# 5. After testing: remove the webhook, and (if you want it closed again) the switch
curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook"
kubectl --context kind-newwave-dev -n whatsapp-commerce set env deploy/server TELEGRAM_ENABLED-
```

**What to watch while a tester chats** (read-only; the same queries are in the tracker steps):
- Server logs: `[telegram-webhook] invalid secret token` = wrong secret; `post-ack processing error` = a bug in handling one update.
- `processed_webhook_events` (`tg:<update_id>`), `consents` (`phone` = `telegram:<chat id>`), `nlp_sessions` (`waPhoneNumber` = `telegram:<chat id>`), `telegram_identities`, `telegram_outbox` (stays empty unless a send fails).
- Nothing should appear in Kafka, Fluvio or Temporal: the Telegram path publishes to none of them.

**More gaps found 2026-09-25 (all in the add-on tracker as KNOWN GAP tests W14, W20, W21):** (1) the **Multi-Channel Hub never shows Telegram chats**: the webhook never writes `channel_messages`, and `channels.processTelegram` has no callers; (2) **merchant-side Telegram needs `settings.telegram.adminChatId`**, which is only read (address-change approval cards, custom offers, digital-PIN alerts) and never written by any screen or API; (3) an in-chat order's payment link is appended as plain text (`Pay here: <url>`); the URL button is only used for system-sent payment links; (4) a fresh test business is in trial / has no approved KYB, so order intake answers the store-not-open message (24 h cooldown per chat) until the business is opened. **Parity with WhatsApp (requirement stated 2026-09-25: everything the app does on WhatsApp must work on Telegram).** **Phase 1 FIXED 2026-09-25, live in `qa-local37`:** Telegram text now runs through the SAME `handleConversationalInbound` menu/session engine as WhatsApp, and button/list taps through `handleInteractiveInbound`, rendered back via a new `telegramRender.ts` (WhatsApp `*bold*`/`_italic_` → Telegram HTML, escaped; buttons/lists → Telegram inline keyboards, with `menu_more_<offset>` pagination on long lists). `hi`, `menu`, `help`, `catalog` now show the SAME tappable welcome menu on both channels (previously Telegram answered "Sorry, I didn't quite get that" to all four, including `menu` itself); `2` (orders) and `3` (human agent, including the admin alert) now match WhatsApp's wording on both channels. A menu tap on Telegram resolves through the identical numbered-selection path a typed digit does, and an unrecognized tap still falls through to the assistant rather than being dropped. Regression journey **J471** (Telegram parity: menu engine + interactive taps match WhatsApp for the same inputs) covers this end to end on real Postgres; mutation-checked (disabling the wiring makes J471 fail, confirming it isn't vacuous). FAQ answers, gift-card balance and STOP already matched and still do.

**Phase 1b FIXED 2026-09-25, live in `qa-local38`:** `/start` (and a fresh "YES" reply, and re-granting after STOP) used to send only the opt-in confirmation text with no menu — a buyer who tapped Start had no idea what to do next. All three grant paths now show the welcome menu in the same turn, matching WhatsApp's "consentGranted + menu" reply. New journey **J476**, mutation-verified 3/3 (all three paths independently confirmed to actually send the menu, not just the confirmation).

**The order-action card + product-image follow-ups (X3) are DONE, not open** — this was mis-recorded as a gap in an earlier pass of this note; the code was already written in phase 1 (`dispatchToNlp`'s `orderCard`/`productImage` handling) but never actually run by a test until today. New journey **J477** drives the real thing end to end: /start → tap Shop → add to cart → confirm → choose pickup → the order is created → the SAME Track/Pay/Cancel card WhatsApp gets arrives as a Telegram inline keyboard → tapping Pay resolves on the correct order (not a generic NLP miss). Mutation-verified (disabling the card send makes it fail). **Still open (X4–X6, KNOWN GAP):** the receipt-screenshot / visual-search / catalog-ai / expense / vendor-bill / stocktake photo chain, Odoo chat commands, click-to-WhatsApp-style keyword campaigns, the onboarding copilot on the intake number. The parity registry in `channelParity.ts` (about 45 categories, nearly all "full"/"adapter") still only covers OUTBOUND notifications, not this inbound surface. Add-on tracker Group X (X0-X6) needs updating to reflect X0-X3 now PASS — pending edit access, see the note at the top of this section. **Setup screen: added 2026-09-25 (build `qa-local36`).** Integration Settings (`/integration-settings`) now has a Telegram card: bot username + write-only token (shown only as `Stored: ••••1234`), an Enabled switch, **Test connection** (server calls Telegram `getMe` with the stored token and flags a username mismatch) and **Register webhook** (server calls `setWebhook` itself with the stored secret and an address it builds from `APP_URL` + tenant id; refuses before contacting Telegram when the server switch is off, the business is not enabled, or the app address is not https). The engineer's browser-console call below is now only a fallback. Still open: no field for the business admin chat (`settings.telegram.adminChatId`), and the older `UnifiedOnboarding.tsx` wizard is dead code (`/unified-onboarding` redirects to `/onboarding`; if it were ever routed it would store the token unencrypted in `unified_onboarding_sessions.channelsConfig`). The Multi-Channel Hub's empty-state hint points to Integration Hub, which has no Telegram option, and Integration Health has a 'Telegram Bot' label that can never appear (`integration_type` has no `telegram`). The webhook reads `tenants.settings.telegram` (encrypted token + secret). Also: the webhook secret is returned once at first save only (rotating means calling the config again with a `webhookSecret`); `J274` (case-variant bot username) passes on PGlite but its test insert stores a JSON *string* on real Postgres, so on real Postgres it does not exercise the unique index (the index itself works: verified with a typed insert).

---

## 8. What happens after you report

- **Group V results:** send the one-line results plus the numbers you saw. A **PASS** on V1 still leaves the shared rate-limit key as an open defect (recorded, not yet fixed); an unexpected movement in V7 becomes a new finding.
- **Any FAIL:** I use your timestamp to pull the matching server / bridge / recon-worker log lines, find the cause, fix it, redeploy, and give you the single test to re-run.
- **All of Group A passing** means QA-020 is verified end to end (the one item I marked "not verified: an interactive login with real credentials").
- **Not covered here on purpose:** the payment/ledger money flow from a real customer payment, TigerBeetle failover with a user mid-session (shared infrastructure — needs the owner's say-so), and the shared TigerBeetle / Postgres namespaces having no network policy.
