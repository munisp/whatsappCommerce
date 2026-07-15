export const ENV = {
  // Database
  postgresUrl: process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
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
