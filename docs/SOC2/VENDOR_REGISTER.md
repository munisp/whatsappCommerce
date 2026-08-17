# Vendor / Subprocessor Register

| Vendor | Role | Data categories shared | Integration point (code) | Notes |
|---|---|---|---|---|
| **Meta / WhatsApp Business Cloud API** | Messaging transport (core) | Customer phone numbers, message content, template content, media; tenant business identity | `server/services/waSender.ts`, `server/services/embeddedSignup/`, `server/routers/whatsappMedia.ts`, webhook ingress (`server/services/webhookDedupe.ts`) | Primary subprocessor. End-customer PII transits Meta by design. DPA + data residency per Meta BAA terms. |
| **Paystack** | Payment processing (cards, transfers, mobile money) | Payer identity (name, phone, email), transaction amounts/references, settlement data | `server/services/paymentConfirm.ts` (confirmation invariant), provider config in `client/src/pages/ProviderSettings.tsx`, `client/src/pages/Payments.tsx` | Financial data processor. Webhook confirmations must pass the paymentConfirm invariant before state change. |
| **Hosting provider (cloud IaaS)** | Infrastructure hosting | All at-rest platform data (encrypted volumes), backups | `Dockerfile`, `docker-compose.yml`, `k8s/`, `DEPLOYMENT.md` | Physical security inherited from provider attestations (SOC2/ISO 27001). |
| **Twenty CRM** *(optional)* | CRM sync for tenants who enable it | Tenant-selected contact/deal data (customer names, phones, order context) | `server/routers/twenty.ts`, `client/src/pages/TwentyCRM.tsx` | Optional per-tenant integration; disabled by default. Self-hostable. |
| **Label Studio** *(optional)* | Annotation of product/shelf images for CV training | Product & shelf photos; no customer PII expected | `server/routers/labelStudio.ts`, `client/src/pages/LabelStudioPipe.tsx` | Optional ML tooling; must be configured to exclude images containing people/documents. |
| **OpenAI / Anthropic** *(optional)* | LLM features (NLP cart, agent) | Conversation snippets sent for inference (may contain customer PII) | `server/services/nlpCart.ts`, `server/routers/agent.ts`, `server/services/aiAgent` paths | Keys via env only (`env.example.txt` placeholders). Evaluate zero-retention API tiers before enabling for production tenants. |
| **Keycloak / SSO** *(optional)* | Identity provider for operator auth | Operator identity (name, email, role) | `server/routers/keycloak.ts`, `client/src/pages/SsoUsers.tsx` | Self-hosted or customer IdP; not a subprocessor when tenant-operated. |

## Review policy

- Register reviewed **quarterly** alongside `compliance.accessReview`.
- New vendor handling customer PII or financial data requires: security review
  entry in `docs/SECURITY_COMPLIANCE.md`, row added here, and DPA on file.
- Optional integrations must default to **off** and document their data
  categories above before being enabled for a tenant.
