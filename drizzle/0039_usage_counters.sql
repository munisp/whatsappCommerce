CREATE TABLE "usage_counters" (
	"tenantId" varchar(36) NOT NULL,
	"metric" varchar(64) NOT NULL,
	"period" varchar(6) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_tenantId_metric_period_pk" PRIMARY KEY("tenantId","metric","period")
);
