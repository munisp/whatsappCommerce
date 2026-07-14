CREATE TABLE `agent_events` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`conversationId` varchar(36) NOT NULL,
	`eventType` varchar(100) NOT NULL,
	`intentType` varchar(100),
	`confidence` decimal(4,3),
	`latencyMs` int,
	`escalated` boolean NOT NULL DEFAULT false,
	`toolCalls` json,
	`inputTokens` int,
	`outputTokens` int,
	`model` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`customerId` varchar(36) NOT NULL,
	`chatwootConversationId` varchar(64),
	`status` enum('open','resolved','pending','snoozed','bot_active','human_active') NOT NULL DEFAULT 'open',
	`channel` varchar(30) NOT NULL DEFAULT 'whatsapp',
	`assignedAgentId` varchar(64),
	`currentFlowStep` varchar(100) DEFAULT 'greeting',
	`lastIntent` varchar(100),
	`cartId` varchar(36),
	`messageCount` int NOT NULL DEFAULT 0,
	`aiHandled` boolean NOT NULL DEFAULT true,
	`escalatedAt` timestamp,
	`resolvedAt` timestamp,
	`firstResponseAt` timestamp,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`whatsappPhone` varchar(30) NOT NULL,
	`name` varchar(255),
	`email` varchar(320),
	`language` varchar(10) DEFAULT 'en',
	`crmContactId` varchar(64),
	`totalOrders` int NOT NULL DEFAULT 0,
	`totalSpent` decimal(14,2) NOT NULL DEFAULT '0.00',
	`lastOrderAt` timestamp,
	`tags` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `customers_tenant_phone_idx` UNIQUE(`tenantId`,`whatsappPhone`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`customerId` varchar(36) NOT NULL,
	`conversationId` varchar(36),
	`orderNumber` varchar(50) NOT NULL,
	`status` enum('pending','confirmed','processing','shipped','delivered','cancelled','refunded') NOT NULL DEFAULT 'pending',
	`totalAmount` decimal(12,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`paymentStatus` enum('unpaid','initiated','completed','failed','refunded') NOT NULL DEFAULT 'unpaid',
	`paymentIntentId` varchar(64),
	`shippingAddress` json,
	`items` json,
	`notes` text,
	`erpOrderId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_number_idx` UNIQUE(`tenantId`,`orderNumber`)
);
--> statement-breakpoint
CREATE TABLE `payment_intents` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`orderId` varchar(36) NOT NULL,
	`customerId` varchar(36) NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`provider` enum('mojaloop','stripe','paystack','flutterwave','manual') NOT NULL DEFAULT 'stripe',
	`status` enum('initiated','pending','completed','failed','cancelled','refunded') NOT NULL DEFAULT 'initiated',
	`providerPaymentId` varchar(256),
	`idempotencyKey` varchar(128) NOT NULL,
	`ledgerPendingId` varchar(36),
	`failureReason` text,
	`metadata` json,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_intents_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_intents_idempotencyKey_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`sku` varchar(100) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`category` varchar(100),
	`price` decimal(12,2) NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`imageUrl` text,
	`status` enum('active','inactive','archived') NOT NULL DEFAULT 'active',
	`stockQuantity` int NOT NULL DEFAULT 0,
	`lowStockThreshold` int DEFAULT 10,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_tenant_sku_idx` UNIQUE(`tenantId`,`sku`)
);
--> statement-breakpoint
CREATE TABLE `service_health` (
	`id` int AUTO_INCREMENT NOT NULL,
	`serviceName` varchar(100) NOT NULL,
	`status` enum('healthy','degraded','down','unknown') NOT NULL DEFAULT 'unknown',
	`latencyMs` int,
	`errorRate` decimal(5,2),
	`lastCheckedAt` timestamp NOT NULL DEFAULT (now()),
	`details` json,
	CONSTRAINT `service_health_id` PRIMARY KEY(`id`),
	CONSTRAINT `service_health_name_idx` UNIQUE(`serviceName`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`plan` enum('starter','growth','enterprise') NOT NULL DEFAULT 'starter',
	`status` enum('active','suspended','trial','churned') NOT NULL DEFAULT 'trial',
	`whatsappPhoneNumberId` varchar(64),
	`whatsappBusinessAccountId` varchar(64),
	`webhookVerifyToken` varchar(128),
	`chatwootAccountId` varchar(64),
	`chatwootApiToken` varchar(256),
	`defaultCurrency` varchar(3) NOT NULL DEFAULT 'USD',
	`defaultLanguage` varchar(10) NOT NULL DEFAULT 'en',
	`aiEnabled` boolean NOT NULL DEFAULT true,
	`aiModel` varchar(64) DEFAULT 'gpt-4o-mini',
	`settings` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`source` varchar(50) NOT NULL,
	`eventType` varchar(100) NOT NULL,
	`status` enum('received','processing','processed','failed') NOT NULL DEFAULT 'received',
	`payload` json,
	`processingError` text,
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `webhook_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','operator','analyst') NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `users` ADD `tenantId` varchar(36);--> statement-breakpoint
CREATE INDEX `agent_events_tenant_idx` ON `agent_events` (`tenantId`);--> statement-breakpoint
CREATE INDEX `agent_events_conversation_idx` ON `agent_events` (`conversationId`);--> statement-breakpoint
CREATE INDEX `agent_events_created_idx` ON `agent_events` (`createdAt`);--> statement-breakpoint
CREATE INDEX `conversations_tenant_idx` ON `conversations` (`tenantId`);--> statement-breakpoint
CREATE INDEX `conversations_status_idx` ON `conversations` (`status`);--> statement-breakpoint
CREATE INDEX `conversations_customer_idx` ON `conversations` (`customerId`);--> statement-breakpoint
CREATE INDEX `customers_tenant_idx` ON `customers` (`tenantId`);--> statement-breakpoint
CREATE INDEX `orders_tenant_idx` ON `orders` (`tenantId`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customerId`);--> statement-breakpoint
CREATE INDEX `payment_intents_tenant_idx` ON `payment_intents` (`tenantId`);--> statement-breakpoint
CREATE INDEX `payment_intents_status_idx` ON `payment_intents` (`status`);--> statement-breakpoint
CREATE INDEX `payment_intents_order_idx` ON `payment_intents` (`orderId`);--> statement-breakpoint
CREATE INDEX `products_tenant_idx` ON `products` (`tenantId`);--> statement-breakpoint
CREATE INDEX `products_status_idx` ON `products` (`status`);--> statement-breakpoint
CREATE INDEX `tenants_status_idx` ON `tenants` (`status`);--> statement-breakpoint
CREATE INDEX `tenants_plan_idx` ON `tenants` (`plan`);--> statement-breakpoint
CREATE INDEX `webhook_events_tenant_idx` ON `webhook_events` (`tenantId`);--> statement-breakpoint
CREATE INDEX `webhook_events_status_idx` ON `webhook_events` (`status`);