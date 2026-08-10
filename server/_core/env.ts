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
};

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
