CREATE TABLE "label_studio_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"labelStudioUrl" varchar(512),
	"apiToken" varchar(256),
	"projectId" integer,
	"projectName" varchar(256),
	"autoExport" boolean DEFAULT false NOT NULL,
	"lastExportedAt" timestamp,
	"exportedCount" integer DEFAULT 0 NOT NULL,
	"isConnected" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "label_studio_configs_tenantId_unique" UNIQUE("tenantId")
);
--> statement-breakpoint
CREATE TABLE "product_taxonomy" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"category" varchar(128) NOT NULL,
	"subcategory" varchar(128),
	"brand" varchar(128) NOT NULL,
	"productName" varchar(256) NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb,
	"aliases" jsonb DEFAULT '[]'::jsonb,
	"countryOrigin" varchar(64) DEFAULT 'Nigeria',
	"isLocal" boolean DEFAULT true NOT NULL,
	"isSachet" boolean DEFAULT false NOT NULL,
	"typicalUnit" varchar(64) DEFAULT 'unit',
	"isActive" boolean DEFAULT true NOT NULL,
	"isCustom" boolean DEFAULT false NOT NULL,
	"tenantId" varchar(36),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visual_inventory_corrections" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"sessionId" varchar(36) NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"detectedLabel" varchar(256) NOT NULL,
	"originalCount" integer NOT NULL,
	"correctedCount" integer NOT NULL,
	"correctedBy" varchar(36),
	"boundingBoxes" jsonb DEFAULT '[]'::jsonb,
	"exportedToLabelStudio" boolean DEFAULT false NOT NULL,
	"labelStudioTaskId" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "label_studio_tenant_idx" ON "label_studio_configs" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "product_taxonomy_category_idx" ON "product_taxonomy" USING btree ("category");--> statement-breakpoint
CREATE INDEX "product_taxonomy_brand_idx" ON "product_taxonomy" USING btree ("brand");--> statement-breakpoint
CREATE INDEX "product_taxonomy_tenant_idx" ON "product_taxonomy" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "vi_corrections_session_idx" ON "visual_inventory_corrections" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "vi_corrections_tenant_idx" ON "visual_inventory_corrections" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "vi_corrections_exported_idx" ON "visual_inventory_corrections" USING btree ("exportedToLabelStudio");