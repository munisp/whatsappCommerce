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
  isProduction: process.env.NODE_ENV === "production",
  // ML Services
  kycServiceUrl: process.env.KYC_SERVICE_URL ?? "http://localhost:8001",
  mlflowUrl: process.env.MLFLOW_URL ?? "http://localhost:5000",
  // WhatsApp
  waToken: process.env.WHATSAPP_TOKEN ?? "",
  waPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  waAppSecret: process.env.WHATSAPP_APP_SECRET ?? "",
  // Payment gateways
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY ?? "",
  flwSecretKey: process.env.FLW_SECRET_KEY ?? "",
  paystackWebhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET ?? "",
  flwWebhookSecret: process.env.FLW_WEBHOOK_SECRET ?? "",
};
