CREATE TABLE `odoo_integrations` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`baseUrl` varchar(512) NOT NULL,
	`database` varchar(128) NOT NULL,
	`username` varchar(255) NOT NULL,
	`apiKey` varchar(512) NOT NULL,
	`status` enum('connected','disconnected','error') NOT NULL DEFAULT 'disconnected',
	`lastSyncAt` timestamp,
	`syncProducts` boolean NOT NULL DEFAULT true,
	`syncOrders` boolean NOT NULL DEFAULT true,
	`syncInvoices` boolean NOT NULL DEFAULT true,
	`whatsappEnabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `odoo_integrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `odoo_integrations_tenantId_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint
CREATE TABLE `odoo_synced_invoices` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`odooId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`partnerName` varchar(255),
	`partnerPhone` varchar(30),
	`state` varchar(50),
	`amountTotal` decimal(14,2),
	`amountResidual` decimal(14,2),
	`currency` varchar(3) DEFAULT 'USD',
	`invoiceDate` timestamp,
	`dueDate` timestamp,
	`whatsappSent` boolean NOT NULL DEFAULT false,
	`rawData` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `odoo_synced_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `odoo_invoices_odoo_id_idx` UNIQUE(`tenantId`,`odooId`)
);
--> statement-breakpoint
CREATE TABLE `odoo_synced_orders` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`odooId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`partnerName` varchar(255),
	`partnerPhone` varchar(30),
	`state` varchar(50),
	`amountTotal` decimal(14,2),
	`currency` varchar(3) DEFAULT 'USD',
	`dateOrder` timestamp,
	`whatsappSent` boolean NOT NULL DEFAULT false,
	`localOrderId` varchar(36),
	`rawData` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `odoo_synced_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `odoo_orders_odoo_id_idx` UNIQUE(`tenantId`,`odooId`)
);
--> statement-breakpoint
CREATE TABLE `odoo_synced_products` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`odooId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`internalRef` varchar(100),
	`price` decimal(12,2),
	`currency` varchar(3) DEFAULT 'USD',
	`category` varchar(255),
	`stockQty` decimal(12,2),
	`active` boolean NOT NULL DEFAULT true,
	`localProductId` varchar(36),
	`rawData` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `odoo_synced_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `odoo_products_odoo_id_idx` UNIQUE(`tenantId`,`odooId`)
);
--> statement-breakpoint
CREATE TABLE `twenty_contacts` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`twentyId` varchar(64) NOT NULL,
	`name` varchar(255),
	`email` varchar(320),
	`phone` varchar(30),
	`company` varchar(255),
	`jobTitle` varchar(255),
	`stage` varchar(100),
	`whatsappPhone` varchar(30),
	`lastWhatsappAt` timestamp,
	`customerId` varchar(36),
	`rawData` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `twenty_contacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `twenty_contacts_twenty_id_idx` UNIQUE(`tenantId`,`twentyId`)
);
--> statement-breakpoint
CREATE TABLE `twenty_deals` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`twentyId` varchar(64) NOT NULL,
	`name` varchar(255),
	`stage` varchar(100),
	`amount` decimal(14,2),
	`currency` varchar(3) DEFAULT 'USD',
	`contactId` varchar(36),
	`closeDate` timestamp,
	`probability` int,
	`rawData` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `twenty_deals_id` PRIMARY KEY(`id`),
	CONSTRAINT `twenty_deals_twenty_id_idx` UNIQUE(`tenantId`,`twentyId`)
);
--> statement-breakpoint
CREATE TABLE `twenty_integrations` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`baseUrl` varchar(512) NOT NULL,
	`apiKey` varchar(512) NOT NULL,
	`workspaceId` varchar(64),
	`status` enum('connected','disconnected','error') NOT NULL DEFAULT 'disconnected',
	`lastSyncAt` timestamp,
	`syncContacts` boolean NOT NULL DEFAULT true,
	`syncDeals` boolean NOT NULL DEFAULT true,
	`whatsappEnabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `twenty_integrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `twenty_integrations_tenantId_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint
CREATE TABLE `whatsapp_menu_items` (
	`id` varchar(36) NOT NULL,
	`menuId` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`parentId` varchar(36),
	`type` enum('section','button','list_item','quick_reply','catalog_link','url') NOT NULL DEFAULT 'button',
	`title` varchar(255) NOT NULL,
	`description` text,
	`payload` varchar(255),
	`url` text,
	`sortOrder` int NOT NULL DEFAULT 0,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `whatsapp_menu_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `whatsapp_menus` (
	`id` varchar(36) NOT NULL,
	`tenantId` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`status` enum('draft','published','archived') NOT NULL DEFAULT 'draft',
	`version` int NOT NULL DEFAULT 1,
	`publishedAt` timestamp,
	`lastPushedAt` timestamp,
	`pushStatus` enum('idle','pushing','success','failed') NOT NULL DEFAULT 'idle',
	`pushError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `whatsapp_menus_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `odoo_integrations_tenant_idx` ON `odoo_integrations` (`tenantId`);--> statement-breakpoint
CREATE INDEX `odoo_invoices_tenant_idx` ON `odoo_synced_invoices` (`tenantId`);--> statement-breakpoint
CREATE INDEX `odoo_orders_tenant_idx` ON `odoo_synced_orders` (`tenantId`);--> statement-breakpoint
CREATE INDEX `odoo_products_tenant_idx` ON `odoo_synced_products` (`tenantId`);--> statement-breakpoint
CREATE INDEX `twenty_contacts_tenant_idx` ON `twenty_contacts` (`tenantId`);--> statement-breakpoint
CREATE INDEX `twenty_deals_tenant_idx` ON `twenty_deals` (`tenantId`);--> statement-breakpoint
CREATE INDEX `twenty_integrations_tenant_idx` ON `twenty_integrations` (`tenantId`);--> statement-breakpoint
CREATE INDEX `menu_items_menu_idx` ON `whatsapp_menu_items` (`menuId`);--> statement-breakpoint
CREATE INDEX `menu_items_tenant_idx` ON `whatsapp_menu_items` (`tenantId`);--> statement-breakpoint
CREATE INDEX `menu_items_parent_idx` ON `whatsapp_menu_items` (`parentId`);--> statement-breakpoint
CREATE INDEX `whatsapp_menus_tenant_idx` ON `whatsapp_menus` (`tenantId`);--> statement-breakpoint
CREATE INDEX `whatsapp_menus_status_idx` ON `whatsapp_menus` (`status`);