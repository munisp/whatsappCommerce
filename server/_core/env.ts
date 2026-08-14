/**
 * Production detection — safe-by-default.
 *
 * The environment is treated as PRODUCTION unless NODE_ENV is explicitly
 * "development" or "test". An unset or unexpected NODE_ENV (a common
 * misconfiguration on live deploys) therefore fails closed into production
 * semantics instead of silently enabling insecure development behavior.
 */
export const isProd = !["development", "test"].includes(process.env.NODE_ENV ?? "");

/**
 * True only when NODE_ENV is explicitly "development". Use this for dev-only
 * conveniences (Vite dev server, demo data). Use isProd for fail-closed
 * security checks. Note NODE_ENV=test is neither isProd nor isDev.
 */
export const isDev = process.env.NODE_ENV === "development";

const KNOWN_INSECURE_DEFAULT_PREFIX = "change-me-in-production";

/**
 * Fail-closed secret guard: in any production-like environment (see isProd —
 * i.e. anything that is not explicitly development/test) the process must
 * refuse to start when a signing/encryption secret is unset or still equals a
 * known insecure default. Called at module load so misconfiguration fails
 * fast at startup.
 */
function assertProductionSecret(name: string, value: string): void {
  if (!isProd) return;
  if (!value || value.startsWith(KNOWN_INSECURE_DEFAULT_PREFIX)) {
    throw new Error(
      `[ENV] FATAL: ${name} is unset or uses the known insecure default ` +
        `"${KNOWN_INSECURE_DEFAULT_PREFIX}*". Set a strong, unique secret ` +
        `before starting (NODE_ENV=${process.env.NODE_ENV ?? "unset"} is treated as production).`
    );
  }
}

export const ENV = {
  // Database
  postgresUrl: process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
  // Middleware
  redisUrl: process.env.REDIS_URL ?? process.env.REDIS_TLS_URL ?? "",
  kafkaBrokers: process.env.KAFKA_BROKERS ?? "kafka:9092",
  kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "wacommerce-node",
  kafkaGroupId: process.env.KAFKA_GROUP_ID ?? "wacommerce-consumers",
  // TigerBeetle / Ledger
  ledgerBridgeUrl: process.env.LEDGER_BRIDGE_URL ?? "http://ledger-bridge:8095",
  tigerBeetleClusterId: process.env.TIGERBEETLE_CLUSTER_ID ?? "0",
  tigerBeetleAddresses: process.env.TIGERBEETLE_ADDRESSES ?? "tigerbeetle:3000",
  // Mojaloop
  mojaloopUrl: process.env.MOJALOOP_URL ?? "http://mojaloop-simulator:3001",
  mojaloopFspId: process.env.MOJALOOP_FSP_ID ?? "wacommerce",
  // APISIX
  apisixAdminUrl: process.env.APISIX_ADMIN_URL ?? "http://apisix:9180",
  apisixAdminKey: process.env.APISIX_ADMIN_KEY ?? "",
  // Permify
  permifyUrl: process.env.PERMIFY_URL ?? "http://permify:3476",
  permifyTenantId: process.env.PERMIFY_TENANT_ID ?? "t1",
  // OpenSearch
  opensearchUrl: process.env.OPENSEARCH_URL ?? "http://opensearch:9200",
  opensearchUser: process.env.OPENSEARCH_USER ?? "admin",
  opensearchPass: process.env.OPENSEARCH_PASS ?? "admin",
  // Dapr
  daprHttpPort: parseInt(process.env.DAPR_HTTP_PORT ?? "3500"),
  daprGrpcPort: parseInt(process.env.DAPR_GRPC_PORT ?? "50001"),
  daprAppId: process.env.DAPR_APP_ID ?? "wacommerce",
  // Fluvio
  fluvioEndpoint: process.env.FLUVIO_ENDPOINT ?? "http://fluvio-sc:9003",
  fluvioConsumerUrl: process.env.FLUVIO_CONSUMER_URL ?? "http://fluvio-consumer:8098",
  // OpenAppSec WAF
  openappsecUrl: process.env.OPENAPPSEC_MGMT_URL ?? "",
  openappsecToken: process.env.OPENAPPSEC_TOKEN ?? "",
  // Ledger Bridge health URL (same as ledgerBridgeUrl but explicit alias)
  ledgerBridgeHealthUrl: process.env.LEDGER_BRIDGE_URL ?? "http://ledger-bridge:8095",
  // Auth (self-hosted Keycloak)
  keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:8080",
  keycloakRealm: process.env.KEYCLOAK_REALM ?? "wacommerce",
  keycloakClientId: process.env.KEYCLOAK_CLIENT_ID ?? "wacommerce-app",
  keycloakClientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "change-me-in-production",
  cookieSecret: process.env.JWT_SECRET ?? "change-me-in-production",
  // Storage (MinIO / S3-compatible)
  s3Endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  s3Bucket: process.env.S3_BUCKET ?? "wacommerce",
  // LLM (Ollama / OpenAI-compatible)
  llmBaseUrl: process.env.LLM_BASE_URL ?? "http://localhost:11434/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "ollama",
  llmModel: process.env.LLM_MODEL ?? "llama3.2",
  // App
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  isProduction: isProd,
  isProd,
  isDev,
  // ML Services
  kycServiceUrl: process.env.KYC_SERVICE_URL ?? "http://localhost:8001",
  mlflowUrl: process.env.MLFLOW_URL ?? "http://localhost:5000",
  // WhatsApp
  waToken: process.env.WHATSAPP_TOKEN ?? "",
  waPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  waAppSecret: process.env.WHATSAPP_APP_SECRET ?? "",
  // WhatsApp conversational onboarding (w9): the platform's own intake number.
  // Both OPTIONAL — unset = feature off, the webhook branch stays inert.
  onboardingPhoneNumberId: process.env.ONBOARDING_PHONE_NUMBER_ID ?? "",
  onboardingWaToken: process.env.ONBOARDING_WA_TOKEN ?? "",
  // Payment gateways
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY ?? "",
  flwSecretKey: process.env.FLW_SECRET_KEY ?? "",
  paystackWebhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET ?? "",
  flwWebhookSecret: process.env.FLW_WEBHOOK_SECRET ?? "",
  // ── W14: credit-bureau reporting (roadmap F3). ALL OPTIONAL — unset means
  // the 'disabled' adapter: events are still logged to bureau_report_log as
  // 'pending' for later backfill, no network is touched. NOT prod-required:
  // bureau reporting is additive and never gates the money path.
  //   BUREAU_PROVIDER   'disabled' (default) | 'crc' | 'creditregistry' | 'customHttp'
  //   BUREAU_API_BASE   bureau endpoint base URL (full URL for customHttp)
  //   BUREAU_API_KEY    bureau credential (never logged; redacted from payloads)
  //   BUREAU_TIMEOUT_MS per-send timeout (default 8000)
  bureauProvider: process.env.BUREAU_PROVIDER ?? "disabled",
  bureauApiBase: process.env.BUREAU_API_BASE ?? "",
  bureauApiKey: process.env.BUREAU_API_KEY ?? "",
  bureauTimeoutMs: parseInt(process.env.BUREAU_TIMEOUT_MS ?? "8000"),
  // ── W16: Shopify app connector (roadmap F7). ALL OPTIONAL — unset means the
  // connector simply reports not-configured; never prod-required, never gates
  // the money path. Secrets are never logged (services/shopifyIntegration
  // redacts before any log/audit write).
  //   SHOPIFY_API_KEY      app client id from the Shopify Partners dashboard
  //   SHOPIFY_API_SECRET   app client secret (OAuth exchange + webhook HMAC)
  //   SHOPIFY_APP_URL      public base URL of this app (OAuth redirect target)
  //   SHOPIFY_SCOPES       comma-separated scopes (default below)
  //   SHOPIFY_API_VERSION  Admin REST API version (default 2024-01)
  //   SHOPIFY_TIMEOUT_MS   per-request timeout to Shopify (default 8000)
  shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET ?? "",
  shopifyAppUrl: process.env.SHOPIFY_APP_URL ?? process.env.APP_URL ?? "",
  shopifyScopes: process.env.SHOPIFY_SCOPES ?? "read_products,write_products,read_orders",
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2024-01",
  shopifyTimeoutMs: parseInt(process.env.SHOPIFY_TIMEOUT_MS ?? "8000"),
};

// ─── Fail-closed startup checks (production-like envs — see isProd) ─────────
// jwtSecret/cookieSecret both derive from JWT_SECRET; refuse to boot with an
// unset or known-default secret unless NODE_ENV is explicitly development/test.
assertProductionSecret("JWT_SECRET", ENV.jwtSecret);
assertProductionSecret("JWT_SECRET (cookieSecret)", ENV.cookieSecret);

// ─── Environment boot gate ──────────────────────────────────────────────────
// Hard dependencies that MUST be explicitly configured in production-like
// environments. Evaluated at import time so a misconfigured deploy fails fast
// at startup with the explicit list of missing variables instead of booting
// half-configured. Aliases accepted where the codebase already supports them
// (DATABASE_URL|POSTGRES_URL, REDIS_URL|REDIS_TLS_URL). Development/test warn
// only — local runs must not require the full stack.
export const REQUIRED_BY_ENV: Record<string, string> = {
  DATABASE_URL: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  KEYCLOAK_URL: process.env.KEYCLOAK_URL ?? "",
  APP_URL: process.env.APP_URL ?? "",
  REDIS_URL: process.env.REDIS_URL ?? process.env.REDIS_TLS_URL ?? "",
  // Master key for at-rest envelope encryption of tenant secrets
  // (server/services/crypto/secrets.ts). Base64-encoded 32 bytes
  // (`openssl rand -base64 32`). Dev/test fall back to a deterministic
  // dev-only key with a loud warning; production refuses to boot without it.
  SECRETS_MASTER_KEY: process.env.SECRETS_MASTER_KEY ?? "",
  // API key for the KYC microservice. KYC_INTERNAL_API_KEY accepted as an
  // alias (the name used by server/routers/kyc.ts). Production refuses to
  // boot when unset or still the known insecure "dev-kyc-key".
  KYC_SERVICE_API_KEY: process.env.KYC_SERVICE_API_KEY ?? process.env.KYC_INTERNAL_API_KEY ?? "",
};

// ─── KYC pipeline fail-closed checks (production only) ─────────────────────
// The KYC/KYB pipeline gates money/trust surfaces. In production-like
// environments it must NEVER boot against mocked or default-credential
// verification:
//   - VLM_MOCK_MODE=true swaps real document vision for a mock — fatal.
//   - an unset/known-default KYC service API key — fatal (the generic
//     REQUIRED_BY_ENV check above already covers unset; this also rejects
//     the well-known dev key).
if (isProd) {
  if ((process.env.VLM_MOCK_MODE ?? "").trim().toLowerCase() === "true") {
    throw new Error(
      "[ENV] FATAL: VLM_MOCK_MODE=true in production — the KYC document " +
        "pipeline would verify against a mock. Unset it before starting.",
    );
  }
  if (REQUIRED_BY_ENV.KYC_SERVICE_API_KEY === "dev-kyc-key") {
    throw new Error(
      '[ENV] FATAL: KYC_SERVICE_API_KEY is the known insecure default "dev-kyc-key". ' +
        "Set a strong, unique key before starting.",
    );
  }
}

// ─── Permify production posture (W12.1; additive, default off) ─────────────
// adminProcedure layers Permify on top of the role check ONLY when PERMIFY_URL
// is set; otherwise the role check stands alone. Deployments that require the
// defense-in-depth layer can set REQUIRE_PERMIFY=true: in production-like
// environments the process then refuses to boot when PERMIFY_URL is unset,
// instead of silently running with Permify disabled. Outside production this
// is a warning so local/dev runs are unaffected.
if ((process.env.REQUIRE_PERMIFY ?? "").trim().toLowerCase() === "true") {
  if (!(process.env.PERMIFY_URL ?? "").trim()) {
    const msg =
      "[ENV] REQUIRE_PERMIFY=true but PERMIFY_URL is unset — the Permify " +
      "authorization layer would be silently disabled for admin procedures.";
    if (isProd) {
      throw new Error(`${msg} Set PERMIFY_URL before starting — refusing to boot.`);
    }
    console.warn(`[ENV] WARNING: ${msg} Allowed to continue outside production.`);
  }
}

const missingRequiredEnv = Object.entries(REQUIRED_BY_ENV)
  .filter(([, value]) => !value || !value.trim())
  .map(([name]) => name);

if (missingRequiredEnv.length > 0) {
  const msg =
    `[ENV] missing required environment variables: ${missingRequiredEnv.join(", ")} ` +
    `(NODE_ENV=${process.env.NODE_ENV ?? "unset"} is treated as ${isProd ? "production" : "development/test"})`;
  if (isProd) {
    throw new Error(`[ENV] FATAL: ${msg}. Set them before starting — refusing to boot.`);
  }
  console.warn(`[ENV] WARNING: ${msg}. Allowed to continue outside production.`);
}

// A *present but malformed* SECRETS_MASTER_KEY is as fatal as a missing one in
// production: it would silently encrypt secrets with the dev-only fallback or
// fail at first use. Validate shape (base64, 32 bytes) at boot.
if (isProd && process.env.SECRETS_MASTER_KEY) {
  let valid = false;
  try {
    valid = Buffer.from(process.env.SECRETS_MASTER_KEY, "base64").length === 32;
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new Error(
      "[ENV] FATAL: SECRETS_MASTER_KEY is not a valid base64-encoded 32-byte key " +
        "(`openssl rand -base64 32`) — refusing to boot.",
    );
  }
}

// ─── Credit-enforcement suspension-check posture (W14; additive) ───────────
// The PO submit gate's trade-credit suspension lookup historically failed
// OPEN on error (a delinquent buyer could order during a lookup outage).
// CREDIT_ENFORCEMENT_STRICT=true forces fail-CLOSED (the lookup error blocks
// submission with a "credit status unavailable, try again" message);
// =false forces fail-open. Unset, the safe default applies: fail-CLOSED in
// production-like environments (see isProd), fail-open in development/test
// so local runs without the credit stack stay usable. Read lazily (function,
// not a load-time const) so tests and runtime toggles see the live value.
export function isCreditEnforcementStrict(): boolean {
  const raw = (process.env.CREDIT_ENFORCEMENT_STRICT ?? "").trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return isProd;
}
