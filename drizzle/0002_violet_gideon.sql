CREATE TYPE "public"."alert_rule_type" AS ENUM('reconciliation_discrepancy', 'low_stock', 'failed_payments', 'model_drift');--> statement-breakpoint
CREATE TYPE "public"."billing_model" AS ENUM('profit_sharing', 'subscription', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('subscription', 'profit_share', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."kyc_document_type" AS ENUM('national_id', 'passport', 'drivers_license', 'residence_permit', 'utility_bill', 'bank_statement', 'business_registration', 'certificate_of_incorporation', 'tax_certificate', 'directors_id');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('not_started', 'pending', 'under_review', 'approved', 'rejected', 'expired', 'resubmit_required');--> statement-breakpoint
CREATE TYPE "public"."kyc_type" AS ENUM('kyc', 'kyb');--> statement-breakpoint
CREATE TYPE "public"."liveness_status" AS ENUM('not_started', 'in_progress', 'passed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."onboarding_step" AS ENUM('business_profile', 'billing_model', 'whatsapp_setup', 'ai_config', 'review', 'completed');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'approved', 'rejected', 'processed');--> statement-breakpoint
CREATE TYPE "public"."subscription_cycle" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"rule_type" "alert_rule_type" NOT NULL,
	"threshold" numeric(10, 4) DEFAULT '5' NOT NULL,
	"window_hours" integer DEFAULT 24 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"notify_owner_on_trigger" boolean DEFAULT true NOT NULL,
	"heartbeat_task_uid" varchar(128),
	"last_triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"cartSessionId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"productName" varchar(255) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unitPrice" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerId" varchar(36),
	"waPhoneNumber" varchar(20),
	"sessionData" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currentStep" varchar(50) DEFAULT 'greeting',
	"language" varchar(20) DEFAULT 'english',
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"invoiceNumber" varchar(50) NOT NULL,
	"type" "invoice_type" DEFAULT 'subscription' NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"periodStart" timestamp,
	"periodEnd" timestamp,
	"subtotal" numeric(12, 2) DEFAULT '0' NOT NULL,
	"commissionRate" numeric(5, 4),
	"commissionAmount" numeric(12, 2),
	"subscriptionFee" numeric(12, 2),
	"totalAmount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"pdfUrl" text,
	"sentAt" timestamp,
	"paidAt" timestamp,
	"dueDate" timestamp,
	"lineItems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_applications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"type" "kyc_type" DEFAULT 'kyb' NOT NULL,
	"status" "kyc_status" DEFAULT 'not_started' NOT NULL,
	"applicantName" varchar(255),
	"applicantEmail" varchar(320),
	"applicantPhone" varchar(30),
	"businessName" varchar(255),
	"businessRegistrationNumber" varchar(100),
	"businessCountry" varchar(100),
	"businessType" varchar(100),
	"riskScore" varchar(10),
	"reviewedBy" varchar(255),
	"reviewNotes" text,
	"rejectionReason" text,
	"submittedAt" timestamp,
	"reviewedAt" timestamp,
	"approvedAt" timestamp,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_documents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"applicationId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"documentType" "kyc_document_type" NOT NULL,
	"fileKey" varchar(512),
	"fileUrl" text,
	"fileName" varchar(255),
	"mimeType" varchar(100),
	"fileSizeBytes" integer,
	"ocrRawText" text,
	"ocrConfidence" varchar(10),
	"extractedData" jsonb,
	"vlmAnalysis" jsonb,
	"doclingStructure" jsonb,
	"isAuthentic" boolean,
	"isTampered" boolean,
	"authenticityScore" varchar(10),
	"verificationNotes" text,
	"processedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liveness_checks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"applicationId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"status" "liveness_status" DEFAULT 'not_started' NOT NULL,
	"sessionToken" varchar(256),
	"livenessScore" varchar(10),
	"faceMatchScore" varchar(10),
	"spoofingDetected" boolean DEFAULT false,
	"frameCount" integer DEFAULT 0,
	"challengeType" varchar(50),
	"challengeCompleted" boolean DEFAULT false,
	"analysisResult" jsonb,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nlp_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"waPhoneNumber" varchar(20) NOT NULL,
	"customerName" varchar(255),
	"language" varchar(20) DEFAULT 'english' NOT NULL,
	"state" varchar(50) DEFAULT 'greeting' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"messageHistory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cartSessionId" varchar(36),
	"lastActivityAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"productName" varchar(255) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unitPrice" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"publicKey" text,
	"secretKey" text,
	"webhookSecret" text,
	"callbackUrl" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderId" varchar(36),
	"customerId" varchar(36),
	"provider" varchar(32) NOT NULL,
	"providerRef" varchar(256),
	"providerTxId" varchar(256),
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(8) DEFAULT 'NGN' NOT NULL,
	"status" varchar(32) DEFAULT 'initiated' NOT NULL,
	"paymentUrl" text,
	"callbackData" jsonb,
	"paidAt" timestamp,
	"failureReason" text,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"reason" text,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"processedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_approval_history" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"templateId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"fromStatus" varchar(50),
	"toStatus" varchar(50) NOT NULL,
	"changedBy" varchar(255),
	"reason" varchar(1000),
	"metaSubmissionId" varchar(128),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_onboarding" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"currentStep" "onboarding_step" DEFAULT 'business_profile' NOT NULL,
	"billingModel" "billing_model",
	"profitShareRate" varchar(10),
	"subscriptionFee" varchar(20),
	"subscriptionCycle" "subscription_cycle" DEFAULT 'monthly',
	"minMonthlyFee" varchar(20),
	"maxProfitShareRate" varchar(10),
	"businessType" varchar(100),
	"businessDescription" varchar(1000),
	"businessCountry" varchar(100),
	"businessCurrency" varchar(3) DEFAULT 'USD',
	"estimatedMonthlyGmv" varchar(20),
	"estimatedMonthlyOrders" integer,
	"whatsappVerified" boolean DEFAULT false NOT NULL,
	"aiConfigured" boolean DEFAULT false NOT NULL,
	"onboardingNotes" varchar(2000),
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_onboarding_tenantId_unique" UNIQUE("tenantId")
);
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cartSessionId_cart_sessions_id_fk" FOREIGN KEY ("cartSessionId") REFERENCES "public"."cart_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nlp_sessions" ADD CONSTRAINT "nlp_sessions_cartSessionId_cart_sessions_id_fk" FOREIGN KEY ("cartSessionId") REFERENCES "public"."cart_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_rules_type_idx" ON "alert_rules" USING btree ("rule_type");--> statement-breakpoint
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "kyc_app_tenant_idx" ON "kyc_applications" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "kyc_app_status_idx" ON "kyc_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "kyc_docs_app_idx" ON "kyc_documents" USING btree ("applicationId");--> statement-breakpoint
CREATE INDEX "liveness_app_idx" ON "liveness_checks" USING btree ("applicationId");--> statement-breakpoint
CREATE INDEX "pgc_tenant_idx" ON "payment_gateway_configs" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "ptx_tenant_idx2" ON "payment_transactions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "ptx_order_idx2" ON "payment_transactions" USING btree ("orderId");--> statement-breakpoint
CREATE INDEX "ptx_status_idx2" ON "payment_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approval_history_template_idx" ON "template_approval_history" USING btree ("templateId");--> statement-breakpoint
CREATE INDEX "onboarding_tenant_idx" ON "tenant_onboarding" USING btree ("tenantId");