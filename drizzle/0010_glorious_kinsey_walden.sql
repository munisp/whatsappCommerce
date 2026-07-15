CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."buyer_type" AS ENUM('retail', 'wholesale', 'distributor', 'government');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'ussd', 'sms', 'telegram', 'instagram', 'email');--> statement-breakpoint
CREATE TYPE "public"."momo_provider" AS ENUM('mtn_momo', 'airtel_money', 'mpesa', 'orange_money', 'wave');--> statement-breakpoint
CREATE TYPE "public"."momo_status" AS ENUM('initiated', 'pending', 'successful', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."procurement_bid_status" AS ENUM('draft', 'submitted', 'shortlisted', 'awarded', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."rfq_status" AS ENUM('draft', 'submitted', 'quoted', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."seller_status" AS ENUM('pending', 'active', 'suspended', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('appointment', 'digital', 'subscription', 'physical');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'paused', 'cancelled', 'expired', 'trial');--> statement-breakpoint
CREATE TYPE "public"."tax_filing_status" AS ENUM('draft', 'submitted', 'accepted', 'rejected', 'under_review');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"serviceId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerPhone" varchar(30) NOT NULL,
	"customerName" varchar(128),
	"scheduledAt" timestamp NOT NULL,
	"durationMinutes" integer DEFAULT 60,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"reminderSent" boolean DEFAULT false,
	"paymentStatus" varchar(20) DEFAULT 'unpaid',
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "b2b_purchase_orders" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"poNumber" varchar(32) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"rfqId" varchar(36),
	"buyerPhone" varchar(30) NOT NULL,
	"buyerName" varchar(128),
	"buyerType" "buyer_type" DEFAULT 'wholesale' NOT NULL,
	"items" jsonb NOT NULL,
	"totalAmount" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"paymentTermsDays" integer DEFAULT 0,
	"dueDate" timestamp,
	"status" "po_status" DEFAULT 'submitted' NOT NULL,
	"approvedBy" varchar(36),
	"approvedAt" timestamp,
	"deliveryAddress" jsonb,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_purchase_orders_poNumber_unique" UNIQUE("poNumber")
);
--> statement-breakpoint
CREATE TABLE "b2b_rfq" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"buyerPhone" varchar(30) NOT NULL,
	"buyerName" varchar(128),
	"buyerType" "buyer_type" DEFAULT 'wholesale' NOT NULL,
	"items" jsonb NOT NULL,
	"totalEstimate" varchar(20),
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" "rfq_status" DEFAULT 'submitted' NOT NULL,
	"quotedPrice" varchar(20),
	"quotedAt" timestamp,
	"expiresAt" timestamp,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cac_registrations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"businessName" varchar(256) NOT NULL,
	"businessType" varchar(64) DEFAULT 'sole_proprietorship' NOT NULL,
	"rcNumber" varchar(32),
	"tinNumber" varchar(32),
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb,
	"submittedAt" timestamp,
	"approvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"channel" "channel" NOT NULL,
	"direction" varchar(10) DEFAULT 'inbound' NOT NULL,
	"fromAddress" varchar(128) NOT NULL,
	"toAddress" varchar(128),
	"tenantId" varchar(36),
	"body" text NOT NULL,
	"metadata" jsonb,
	"processed" boolean DEFAULT false NOT NULL,
	"nlpResponse" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "churn_predictions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerPhone" varchar(30) NOT NULL,
	"churnScore" varchar(10) NOT NULL,
	"riskLevel" varchar(10) DEFAULT 'medium' NOT NULL,
	"daysSinceLastOrder" integer,
	"predictedChurnDate" timestamp,
	"interventionSent" boolean DEFAULT false,
	"calculatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"cohortMonth" varchar(7) NOT NULL,
	"totalCustomers" integer DEFAULT 0 NOT NULL,
	"retentionByMonth" jsonb DEFAULT '{}'::jsonb,
	"avgOrderValue" varchar(20),
	"totalRevenue" varchar(20),
	"calculatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_product_purchases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"productId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerPhone" varchar(30) NOT NULL,
	"downloadToken" varchar(64) NOT NULL,
	"downloadsUsed" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "digital_product_purchases_downloadToken_unique" UNIQUE("downloadToken")
);
--> statement-breakpoint
CREATE TABLE "digital_products" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"price" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"fileKey" varchar(256),
	"fileUrl" text,
	"mimeType" varchar(128),
	"downloadLimit" integer DEFAULT 3,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forex_rates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"baseCurrency" varchar(3) NOT NULL,
	"quoteCurrency" varchar(3) NOT NULL,
	"rate" varchar(20) NOT NULL,
	"source" varchar(64) DEFAULT 'manual',
	"fetchedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "government_contracts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"bidId" varchar(36),
	"contractNumber" varchar(64) NOT NULL,
	"procuringEntity" varchar(256) NOT NULL,
	"contractValue" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"startDate" timestamp,
	"endDate" timestamp,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb,
	"invoicesRaised" integer DEFAULT 0,
	"amountPaid" varchar(20) DEFAULT '0.00',
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ltv_scores" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerPhone" varchar(30) NOT NULL,
	"predictedLtv" varchar(20) NOT NULL,
	"historicalRevenue" varchar(20) NOT NULL,
	"orderCount" integer DEFAULT 0 NOT NULL,
	"avgOrderValue" varchar(20),
	"segment" varchar(20) DEFAULT 'medium',
	"calculatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_commissions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"sellerId" varchar(36) NOT NULL,
	"orderId" varchar(36) NOT NULL,
	"saleAmount" varchar(20) NOT NULL,
	"commissionRate" varchar(10) NOT NULL,
	"commissionAmount" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"settledAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_sellers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"businessName" varchar(128) NOT NULL,
	"ownerPhone" varchar(30) NOT NULL,
	"ownerName" varchar(128),
	"email" varchar(256),
	"category" varchar(64),
	"commissionRate" varchar(10) DEFAULT '10.00' NOT NULL,
	"status" "seller_status" DEFAULT 'pending' NOT NULL,
	"kycVerified" boolean DEFAULT false NOT NULL,
	"bankAccount" jsonb,
	"totalSales" varchar(20) DEFAULT '0.00',
	"totalCommission" varchar(20) DEFAULT '0.00',
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mobile_money_transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"orderId" varchar(36),
	"provider" "momo_provider" NOT NULL,
	"externalRef" varchar(128),
	"phoneNumber" varchar(30) NOT NULL,
	"amount" varchar(20) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "momo_status" DEFAULT 'initiated' NOT NULL,
	"providerResponse" jsonb,
	"callbackPayload" jsonb,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_bids" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"contractTitle" varchar(256) NOT NULL,
	"procuringEntity" varchar(256) NOT NULL,
	"contractValue" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" "procurement_bid_status" DEFAULT 'draft' NOT NULL,
	"deadline" timestamp,
	"documents" jsonb DEFAULT '[]'::jsonb,
	"technicalProposal" text,
	"financialProposal" text,
	"submittedAt" timestamp,
	"awardedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_products" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"sellerId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"price" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"stockQuantity" integer DEFAULT 0 NOT NULL,
	"category" varchar(64),
	"images" jsonb DEFAULT '[]'::jsonb,
	"isApproved" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_catalog" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"serviceType" "service_type" NOT NULL,
	"price" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"duration" integer,
	"maxBookingsPerSlot" integer DEFAULT 1,
	"availableSlots" jsonb DEFAULT '[]'::jsonb,
	"downloadUrl" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"serviceId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"customerPhone" varchar(30) NOT NULL,
	"customerName" varchar(128),
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"billingCycle" varchar(20) DEFAULT 'monthly' NOT NULL,
	"amount" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"currentPeriodStart" timestamp NOT NULL,
	"currentPeriodEnd" timestamp NOT NULL,
	"cancelledAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_filings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"filingType" varchar(32) DEFAULT 'vat' NOT NULL,
	"taxAuthority" varchar(32) DEFAULT 'firs' NOT NULL,
	"periodStart" timestamp NOT NULL,
	"periodEnd" timestamp NOT NULL,
	"grossRevenue" varchar(20) NOT NULL,
	"taxableAmount" varchar(20) NOT NULL,
	"taxAmount" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"status" "tax_filing_status" DEFAULT 'draft' NOT NULL,
	"referenceNumber" varchar(64),
	"submittedAt" timestamp,
	"documents" jsonb DEFAULT '[]'::jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ussd_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"sessionId" varchar(128) NOT NULL,
	"phoneNumber" varchar(30) NOT NULL,
	"serviceCode" varchar(20),
	"tenantId" varchar(36),
	"currentMenu" varchar(64) DEFAULT 'greeting',
	"menuHistory" jsonb DEFAULT '[]'::jsonb,
	"nlpSessionId" varchar(36),
	"isActive" boolean DEFAULT true NOT NULL,
	"lastInput" text,
	"lastResponse" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ussd_sessions_sessionId_unique" UNIQUE("sessionId")
);
--> statement-breakpoint
CREATE TABLE "wholesale_price_tiers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"buyerType" "buyer_type" NOT NULL,
	"minQuantity" integer DEFAULT 1 NOT NULL,
	"maxQuantity" integer,
	"unitPrice" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"discountPercent" varchar(10),
	"paymentTermsDays" integer DEFAULT 0,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
