# Manual test cases (skill §9, §52, §67)

These are the checks that need a real browser and/or a real Keycloak session, which the automated environment used for this QA pass did not have (UI, accessibility and OAuth-redirect flows are a documented tooling gap). Each one is written to be followed without guessing. **Run them against a non-production environment first.**

Conventions: `APP` = the merchant SPA origin; `ADMIN` = the platform-admin origin; capture a screenshot **and** the browser devtools Network entry for every FAIL.
Accounts needed: **T-OWNER-A** (owner of tenant A), **T-STAFF-A** (non-owner member of tenant A), **T-OWNER-B** (owner of tenant B), **PLAT-ADMIN** (platform admin).

---
## MT-01 — Login CSRF is currently possible via the SPA login path (QA-020) — reproduce, then re-run after the fix
ROLE: none (attacker + victim browsers) · OBJECTIVE: confirm whether a callback URL minted by someone else logs the victim in as that person.
PRECONDITIONS: two browsers/profiles (A = attacker, V = victim), both with no session for `APP`.
1. In A, open `APP`, click **Sign in**. When Keycloak's login page appears, log in as T-OWNER-A. Keycloak redirects to `APP/api/auth/callback?code=…&state=…`. **Before that request completes**, copy the full URL (use devtools "Preserve log", or copy from the address bar and cancel the navigation).
2. In V, paste that URL into the address bar and load it.
3. In V, open `APP` and check who is signed in (top-right user menu).
EXPECTED (after fix): V is **not** signed in as T-OWNER-A (callback rejected: state/nonce cookie missing or mismatched).
FAIL IF: V shows T-OWNER-A's account. (Expected to fail today — this is the login-CSRF finding.)
CAPTURE: screenshot of V's user menu, the callback response status/headers.

## MT-02 — `__Host-oauth_state` cookie is actually set (QA-020)
ROLE: any · 1. On `APP` (https), open devtools → Application → Cookies. 2. Click **Sign in** and stop at the Keycloak login page. 3. Look for a cookie named `__Host-oauth_state`.
EXPECTED: present, `Secure`, `Path=/`. FAIL IF: absent (browsers drop `__Host-` cookies set without `Secure`, which is how the client sets it today).

## MT-03 — Server-initiated login (PKCE + nonce) completes across two server replicas (QA-018)
ROLE: any · PRECONDITIONS: `server` scaled to ≥2 replicas; you can reach `APP/api/auth/login`.
1. Open `APP/api/auth/login?redirect=/`. In devtools note the `code_challenge` (S256) in the Keycloak URL and the `wa_oauth_tx` cookie (HttpOnly, so visible in the Application tab, not to JS).
2. Complete the Keycloak login. 3. Repeat 5 times (traffic will land on different replicas).
EXPECTED: all 5 logins succeed. FAIL IF: any returns `401 Token exchange failed` or `401 Nonce mismatch`.

## MT-04 — Non-admin cannot start a fine-tune run; export is tenant-scoped
ROLE: T-STAFF-A, then PLAT-ADMIN · URL: `APP` → Inventory Hub → Product Image Collector.
1. As T-STAFF-A: open the **Fine-Tune Pipeline** panel. EXPECTED: **Start Fine-Tune Run** is disabled with tooltip "limited to platform admins".
2. As T-STAFF-A: click **Export YOLO Labels**. EXPECTED: downloads a ZIP containing only tenant A's classes (open `classes.txt` / `manifest.json`). FAIL IF: it contains classes/images belonging to tenant B.
3. As PLAT-ADMIN: repeat 1 and 2. EXPECTED: Start is enabled; the ZIP is platform-wide.
4. Open `preview.html` from the ZIP in a browser. EXPECTED: renders; no alert dialogs. To test the escaping, first upload an image with class name `</span><script>alert(1)</script>` as T-OWNER-A and export again — EXPECTED: the class name shows as literal text, no script runs.

## MT-05 — ML Ops dashboard triggers are admin-only
ROLE: T-OWNER-A, then PLAT-ADMIN · URL: `APP/ml-ops`. 1. As T-OWNER-A click **Retrain** on any model and the "Real-data retrain" button. EXPECTED: a red toast "Retraining failed: … admin …" (FORBIDDEN); no job starts. 2. As PLAT-ADMIN: same buttons. EXPECTED: success toast (only on an environment that has the training scripts). Read-only tabs must still load for T-OWNER-A.

## MT-06 — Dispute evidence tokens are tenant-scoped (QA-015)
ROLE: T-OWNER-A, T-OWNER-B · PRECONDITIONS: tenant A has a dispute D-A with an evidence link generated.
1. As T-OWNER-A: Disputes → D-A → **Evidence links**. EXPECTED: the link/token list shows.
2. As T-OWNER-B: call the same screen/API with D-A's id (paste D-A's id into the URL or replay the request from devtools with tenant B's cookie). EXPECTED: "Dispute not found"; **no token value is disclosed**. FAIL IF: any token is returned.
3. As T-OWNER-B: try **Revoke** with a token copied from tenant A. EXPECTED: "Token not found"; the buyer's link still works.

## MT-07 — Tenant Keycloak SSO settings reject internal addresses (QA-016)
ROLE: T-OWNER-A · URL: Settings → Integrations → SSO (Keycloak). 1. Enter server URL `http://169.254.169.254/` → Save. EXPECTED: rejected with "SSRF guard rejected…". 2. Repeat with `http://127.0.0.1:8080`, `http://10.0.0.5`. EXPECTED: rejected. 3. `https://auth.example.com` → EXPECTED: saved. Repeat 1–2 for Twenty CRM and Label Studio URLs.

## MT-08 — Money-moving actions need a finance-capable role (QA-005/006)
ROLE: T-STAFF-A (analyst/catalog membership) vs T-OWNER-A · For each: gift-card adjust, RMA refund, marketplace commission settle, COD payout retry, savings settle, procurement PO approve, trade-credit approve/repayment. EXPECTED: staff → "Money-moving actions require tenant role…"; owner/operator/finance → succeeds.

## MT-09 — Accessibility spot-check (not automated)
ROLE: T-OWNER-A · Keyboard only (no mouse) on: login → dashboard → Orders list → an order → Inventory Hub upload dialog. EXPECTED: every control reachable with Tab, visible focus ring, dialogs trap and restore focus, Esc closes. Run the browser's Lighthouse/axe scan on the same 5 pages and record the violations count. This was **not** performed.

## MT-10 — Rollback drill on a real environment
ROLE: operator · `kubectl rollout history deploy/server -n whatsapp-commerce`; note revision N. Deploy N+1, confirm `/health/ready` 200 and a login works; `kubectl rollout undo deploy/server`; confirm revision N serves and a login works; confirm no data written by N+1 is unreadable by N (create an order on N+1, read it on N). (An automated version of the deploy/undo half was run against the dev cluster — see the readiness report.)

---
## Final checklist per role (§52)
**T-OWNER-A:** [ ] MT-01/02 login [ ] MT-03 [ ] MT-04 [ ] MT-05 (expect FORBIDDEN) [ ] MT-06 step 1 [ ] MT-07 [ ] MT-08 (allowed) [ ] MT-09
**T-STAFF-A:** [ ] MT-04 steps 1–2 [ ] MT-08 (denied)
**T-OWNER-B:** [ ] MT-06 steps 2–3 (cross-tenant denied)
**PLAT-ADMIN:** [ ] MT-04 steps 3–4 [ ] MT-05 (allowed)
**Operator:** [ ] MT-10
